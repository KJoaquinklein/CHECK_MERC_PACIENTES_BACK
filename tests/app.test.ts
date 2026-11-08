import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { cargarEnv, EntornoInvalidoError } from '../src/config/env.js';
import { crearLogger } from '../src/config/logger.js';
import { crearPool } from '../src/db/pool.js';
import { crearStorage } from '../src/storage/index.js';

const envBase = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://usuario:clave@localhost:5432/prueba',
  CORS_ORIGINS: 'http://localhost:5173',
  STORAGE_LOCAL_DIR: './storage-local',
};

function app(extra: Record<string, string> = {}) {
  const env = cargarEnv({ ...envBase, ...extra });
  // El pool no abre conexiones hasta que se lo usa: estas pruebas no tocan la base
  return crearApp(env, crearLogger(env), crearPool(env), crearStorage(env));
}

describe('GET /salud', () => {
  it('responde ok y devuelve un X-Request-Id', async () => {
    const res = await request(app()).get('/salud');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ estado: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('respeta API_PREFIX', async () => {
    const a = app({ API_PREFIX: '/api' });
    expect((await request(a).get('/api/salud')).status).toBe(200);
    expect((await request(a).get('/salud')).status).toBe(404);
  });
});

describe('manejo de errores', () => {
  it('ruta inexistente: 404 con formato estándar', async () => {
    const res = await request(app()).get('/no-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_ENCONTRADO');
  });

  it('JSON malformado: 400 VALIDACION', async () => {
    const res = await request(app())
      .post('/salud')
      .set('Content-Type', 'application/json')
      .send('{malo');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDACION');
  });

  it('body mayor a 100 KB: 413', async () => {
    const res = await request(app())
      .post('/salud')
      .send({ x: 'a'.repeat(120_000) });
    expect(res.status).toBe(413);
  });
});

describe('cargarEnv', () => {
  it('informa las variables faltantes sin exponer valores', () => {
    try {
      cargarEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://u:secreto@h/db' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EntornoInvalidoError);
      const mensaje = (error as Error).message;
      expect(mensaje).toContain('CORS_ORIGINS');
      expect(mensaje).not.toContain('secreto');
    }
  });

  it('exige las variables S3 con STORAGE_DRIVER=s3', () => {
    expect(() => cargarEnv({ ...envBase, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });

  it('no permite el driver local en producción', () => {
    expect(() => cargarEnv({ ...envBase, NODE_ENV: 'production' })).toThrow(/producción/);
  });
});

describe('cabeceras de seguridad', () => {
  it('helmet está activo y no se anuncia el framework', async () => {
    const res = await request(app()).get('/salud');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});

describe('CORS', () => {
  const preflight = (origen: string) =>
    request(app())
      .options('/auth/login')
      .set('Origin', origen)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-requested-with');

  it('acepta solo el origen configurado, con credenciales', async () => {
    const permitido = await preflight('http://localhost:5173');
    expect(permitido.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(permitido.headers['access-control-allow-credentials']).toBe('true');
  });

  it('no autoriza a ningún otro origen', async () => {
    for (const origen of ['https://sitio-malo.example', 'http://localhost:5174', 'null']) {
      const res = await preflight(origen);
      expect(res.headers['access-control-allow-origin'], origen).toBeUndefined();
    }
  });
});

describe('límite general de peticiones', () => {
  it('responde 429 con el formato estándar al superar RATE_LIMIT_MAX', async () => {
    const limitada = app({ RATE_LIMIT_MAX: '3' });
    const estados: number[] = [];
    for (let i = 0; i < 4; i++) estados.push((await request(limitada).get('/salud')).status);
    expect(estados).toEqual([200, 200, 200, 429]);
    const bloqueada = await request(limitada).get('/salud');
    expect(bloqueada.body.error.code).toBe('DEMASIADOS_INTENTOS');
  });
});

describe('errores internos', () => {
  it('devuelven un mensaje genérico con request_id, sin detalles de la base ni trazas', async () => {
    // Base inalcanzable (puerto 1): la validación de la sesión falla con un error de conexión
    const roto = app({ DATABASE_URL: 'postgres://usuario:clave@127.0.0.1:1/inexistente' });
    const res = await request(roto)
      .get('/auth/me')
      .set('Cookie', `sid=${'a'.repeat(43)}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('ERROR_INTERNO');
    expect(res.body.error.request_id).toBe(res.headers['x-request-id']);
    const cuerpo = JSON.stringify(res.body);
    for (const filtrado of [
      'ECONNREFUSED',
      '127.0.0.1',
      'inexistente',
      'usuario',
      'stack',
      ' at ',
    ]) {
      expect(cuerpo, filtrado).not.toContain(filtrado);
    }
  });
});
