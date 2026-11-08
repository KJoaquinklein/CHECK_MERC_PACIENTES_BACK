import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import request from 'supertest';
import { crearApp } from '../../src/app.js';
import { cargarEnv } from '../../src/config/env.js';
import { crearLogger } from '../../src/config/logger.js';
import type { StorageDriver } from '../../src/storage/driver.js';
import { crearStorage } from '../../src/storage/index.js';
import { hashearPassword } from '../../src/modules/auth/password.js';
import type { ConfigBasePruebas } from './db.js';
import { poolApp } from './db.js';

export const CLAVE_VALIDA = 'clave-de-prueba-1234';
export const ENCABEZADO_AJAX = { 'X-Requested-With': 'pruebas' } as const;

/**
 * App real conectada a la base de pruebas con el rol hc_app. Por defecto guarda los archivos en
 * una carpeta temporal propia; se puede inyectar otro driver (por ejemplo uno S3).
 */
export function crearAppDePrueba(
  config: ConfigBasePruebas,
  extraEnv: Record<string, string> = {},
  opciones: { storage?: StorageDriver } = {},
) {
  const directorioStorage = mkdtempSync(path.join(os.tmpdir(), 'hc-storage-'));
  const env = cargarEnv({
    NODE_ENV: 'test',
    DATABASE_URL: config.urlApp,
    DATABASE_SSL: String(config.ssl),
    CORS_ORIGINS: 'http://localhost:5173',
    STORAGE_LOCAL_DIR: directorioStorage,
    // Muchas pruebas inician sesión: el límite estricto se prueba aparte
    LOGIN_RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_MAX: '100000',
    ...extraEnv,
  });
  const pool = poolApp(config);
  const storage = opciones.storage ?? crearStorage(env);
  return { app: crearApp(env, crearLogger(env), pool, storage), pool, storage, directorioStorage };
}

interface DatosUsuario {
  nombre_usuario: string;
  rol?: 'admin' | 'profesional';
  password?: string;
  activo?: boolean;
  debe_cambiar_password?: boolean;
}

/** Inserta un usuario directamente (con el pool del migrador), sin pasar por la API. */
export async function insertarUsuario(migrador: pg.Pool, datos: DatosUsuario): Promise<number> {
  const hash = await hashearPassword(datos.password ?? CLAVE_VALIDA);
  const { rows } = await migrador.query<{ id: number }>(
    `INSERT INTO usuario (nombre_usuario, nombre_completo, rol, password_hash, activo,
                          debe_cambiar_password)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      datos.nombre_usuario,
      `Usuario ${datos.nombre_usuario}`,
      datos.rol ?? 'profesional',
      hash,
      datos.activo ?? true,
      datos.debe_cambiar_password ?? false,
    ],
  );
  return rows[0]!.id;
}

/** Inicia sesión por la API y devuelve el valor para el encabezado Cookie. */
export async function iniciarSesionComo(
  app: Parameters<typeof request>[0],
  nombreUsuario: string,
  password = CLAVE_VALIDA,
): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .set(ENCABEZADO_AJAX)
    .send({ nombre_usuario: nombreUsuario, password });
  if (res.status !== 200) throw new Error(`El login de ${nombreUsuario} falló: ${res.status}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('sid='),
  );
  return cookie!.split(';')[0]!;
}

type Metodo = 'get' | 'post' | 'patch' | 'delete';

/** Atajo para llamar a la API con el encabezado anti-CSRF y, opcionalmente, una cookie. */
export function crearLlamador(app: Parameters<typeof request>[0]) {
  return (metodo: Metodo, ruta: string, cookie?: string, cuerpo?: object) => {
    const peticion = request(app)[metodo](ruta).set(ENCABEZADO_AJAX);
    if (cookie) peticion.set('Cookie', cookie);
    return cuerpo ? peticion.send(cuerpo) : peticion;
  };
}

/** Todas las acciones de auditoría de un tipo, en orden. */
export async function auditoriaDe(migrador: pg.Pool, accion: string) {
  const { rows } = await migrador.query(
    'SELECT id_usuario, entidad, entidad_id, detalle FROM auditoria WHERE accion = $1 ORDER BY id',
    [accion],
  );
  return rows;
}
