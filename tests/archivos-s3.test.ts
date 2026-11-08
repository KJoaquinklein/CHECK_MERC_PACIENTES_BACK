import { rmSync } from 'node:fs';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditoriaDe,
  crearAppDePrueba,
  crearLlamador,
  insertarUsuario,
  iniciarSesionComo,
} from './utilidades/app.js';
import { EXE, PDF, subirArchivo, temporalesPendientes } from './utilidades/archivos.js';
import {
  configBasePruebas,
  limpiarDatos,
  limpiarDatosClinicos,
  poolMigrador,
  type ConfigBasePruebas,
} from './utilidades/db.js';
import { crearS3DePrueba, S3Falso } from './utilidades/s3-falso.js';

const config: ConfigBasePruebas | null = configBasePruebas();

/**
 * El mismo flujo de la API pero con el driver S3. Usa el SDK real de AWS: contra un servidor S3
 * simulado, o contra un bucket real de PRUEBAS si están definidas las variables TEST_S3_*.
 */
describe.skipIf(!config)('archivos de pacientes, driver S3 (PostgreSQL real)', () => {
  const falso = new S3Falso();
  let s3: ReturnType<typeof crearS3DePrueba>;
  let streaming: ReturnType<typeof crearAppDePrueba>;
  let redireccion: ReturnType<typeof crearAppDePrueba>;
  let migrador: pg.Pool;
  let llamar: ReturnType<typeof crearLlamador>;
  let cookie: string;
  const clavesCreadas = new Set<string>();

  beforeAll(async () => {
    await falso.iniciar();
    s3 = crearS3DePrueba(falso);
    streaming = crearAppDePrueba(config!, {}, { storage: s3.storage });
    redireccion = crearAppDePrueba(
      config!,
      { DOWNLOAD_MODE: 'redirect', SIGNED_URL_TTL_SECONDS: '30' },
      { storage: s3.storage },
    );
    migrador = poolMigrador(config!);
    llamar = crearLlamador(streaming.app);
    await limpiarDatos(migrador);
    await insertarUsuario(migrador, { nombre_usuario: 'profe' });
    cookie = await iniciarSesionComo(streaming.app, 'profe');
  });
  afterAll(async () => {
    for (const clave of clavesCreadas) await s3.storage.delete(clave);
    for (const instancia of [streaming, redireccion]) {
      await instancia.pool.end();
      rmSync(instancia.directorioStorage, { recursive: true, force: true });
    }
    await migrador.end();
    await falso.detener();
  });
  beforeEach(async () => {
    await limpiarDatosClinicos(migrador);
  });

  async function paciente() {
    const { rows } = await migrador.query<{ id: number }>(
      "INSERT INTO paciente (nombre_completo) VALUES ('Ana Pérez') RETURNING id",
    );
    return rows[0]!.id;
  }
  async function subir(app: typeof streaming.app = streaming.app) {
    const res = await subirArchivo(
      app,
      cookie,
      { id_paciente: await paciente() },
      { contenido: PDF, nombre: 'estudio.pdf', mime: 'application/pdf' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { rows } = await migrador.query(
      'SELECT storage_key FROM paciente_archivo WHERE id = $1',
      [res.body.id],
    );
    clavesCreadas.add(rows[0].storage_key);
    return { id: res.body.id as number, clave: rows[0].storage_key as string };
  }

  it('guarda el objeto en el bucket con el tipo detectado y lo descarga idéntico', async () => {
    const { id, clave } = await subir();
    expect(clave).toMatch(/^estudios\/\d+\/[0-9a-f-]{36}\.pdf$/);
    expect(await s3.storage.exists(clave)).toBe(true);
    if (!s3.esReal) expect(falso.objetos.get(clave)?.contentType).toBe('application/pdf');

    const res = await request(streaming.app)
      .get(`/archivos/${id}/contenido`)
      .set('Cookie', cookie)
      .responseType('blob');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).equals(PDF)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(await auditoriaDe(migrador, 'ver_archivo')).toHaveLength(1);
  });

  it('con DOWNLOAD_MODE=redirect responde 302 a una URL firmada de corta duración', async () => {
    const { id } = await subir(redireccion.app);

    const res = await request(redireccion.app)
      .get(`/archivos/${id}/contenido`)
      .set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const destino = new URL(res.headers.location!);
    expect(destino.origin).toBe(new URL(s3.config.endpoint).origin);
    expect(destino.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(destino.searchParams.get('X-Amz-Expires')).toBe('30');
    expect(destino.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(destino.searchParams.get('response-content-disposition')).toContain(
      'inline; filename="estudio.pdf"',
    );

    // La URL firmada sirve el archivo directamente desde el almacenamiento
    const directa = await fetch(res.headers.location!);
    expect(directa.status).toBe(200);
    expect(directa.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await directa.arrayBuffer()).equals(PDF)).toBe(true);

    // Aun redirigiendo, la lectura queda auditada y sin sesión no hay redirección
    expect(await auditoriaDe(migrador, 'ver_archivo')).toHaveLength(1);
    expect((await request(redireccion.app).get(`/archivos/${id}/contenido`)).status).toBe(401);
    expect(await auditoriaDe(migrador, 'ver_archivo')).toHaveLength(1);
  });

  it('la baja lógica no borra el objeto del bucket', async () => {
    const { id, clave } = await subir();
    await llamar('delete', `/archivos/${id}`, cookie).expect(200);
    expect(await s3.storage.exists(clave)).toBe(true);
    expect((await llamar('get', `/archivos/${id}/contenido`, cookie)).status).toBe(404);

    await llamar('post', `/archivos/${id}/restaurar`, cookie).expect(200);
    expect((await llamar('get', `/archivos/${id}/contenido`, cookie)).status).toBe(200);
    expect(await s3.storage.exists(clave)).toBe(true);
  });

  it('un archivo rechazado no deja nada en el bucket', async () => {
    const antes = s3.esReal ? 0 : falso.objetos.size;
    const res = await subirArchivo(
      streaming.app,
      cookie,
      { id_paciente: await paciente() },
      { contenido: EXE, nombre: 'factura.pdf', mime: 'application/pdf' },
    );
    expect(res.status).toBe(415);
    if (!s3.esReal) expect(falso.objetos.size).toBe(antes);
    expect(temporalesPendientes()).toBe(0);
  });

  it('si el objeto falta en el bucket responde 404 sin romper', async () => {
    const { id, clave } = await subir();
    await s3.storage.delete(clave);
    const res = await llamar('get', `/archivos/${id}/contenido`, cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ARCHIVO_NO_DISPONIBLE');
  });
});
