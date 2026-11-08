import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  crearAppDePrueba,
  crearLlamador,
  insertarUsuario,
  iniciarSesionComo,
} from './utilidades/app.js';
import {
  configBasePruebas,
  limpiarDatos,
  limpiarDatosClinicos,
  poolMigrador,
  type ConfigBasePruebas,
} from './utilidades/db.js';

const config: ConfigBasePruebas | null = configBasePruebas();

describe.skipIf(!config)('obras sociales (PostgreSQL real)', () => {
  let poolDeLaApp: pg.Pool;
  let migrador: pg.Pool;
  let llamar: ReturnType<typeof crearLlamador>;
  let cookie: string;

  beforeAll(async () => {
    const creada = crearAppDePrueba(config!);
    poolDeLaApp = creada.pool;
    migrador = poolMigrador(config!);
    llamar = crearLlamador(creada.app);
    await limpiarDatos(migrador);
    // Un profesional (no administrador): el catálogo es para todos los roles
    await insertarUsuario(migrador, { nombre_usuario: 'profe', rol: 'profesional' });
    cookie = await iniciarSesionComo(creada.app, 'profe');
  });
  afterAll(async () => {
    await poolDeLaApp.end();
    await migrador.end();
  });
  beforeEach(async () => {
    await limpiarDatosClinicos(migrador);
  });

  it('exige sesión', async () => {
    for (const [metodo, ruta] of [
      ['get', '/obras-sociales'],
      ['post', '/obras-sociales'],
      ['patch', '/obras-sociales/1'],
      ['delete', '/obras-sociales/1'],
    ] as const) {
      expect((await llamar(metodo, ruta)).status, `${metodo} ${ruta}`).toBe(401);
    }
  });

  it('crea, lista y edita (cualquier rol)', async () => {
    const creada = await llamar('post', '/obras-sociales', cookie, { nombre: '  OSDE  ' });
    expect(creada.status).toBe(201);
    expect(creada.body).toEqual({ id: expect.any(Number), nombre: 'OSDE', activa: true });

    const editada = await llamar('patch', `/obras-sociales/${creada.body.id}`, cookie, {
      nombre: 'OSDE 210',
    });
    expect(editada.status).toBe(200);
    expect(editada.body.nombre).toBe('OSDE 210');

    const lista = await llamar('get', '/obras-sociales', cookie);
    expect(lista.status).toBe(200);
    expect(lista.body.data).toEqual([{ id: creada.body.id, nombre: 'OSDE 210', activa: true }]);
    expect(lista.body.meta).toEqual({ page: 1, page_size: 25, total: 1 });
  });

  it('el nombre es único sin distinguir mayúsculas, al crear y al renombrar', async () => {
    await llamar('post', '/obras-sociales', cookie, { nombre: 'Swiss Medical' }).expect(201);
    const otra = await llamar('post', '/obras-sociales', cookie, { nombre: 'OSDE' });

    const duplicada = await llamar('post', '/obras-sociales', cookie, { nombre: 'SWISS medical' });
    expect(duplicada.status).toBe(409);
    expect(duplicada.body.error.code).toBe('OBRA_SOCIAL_DUPLICADA');

    const renombrada = await llamar('patch', `/obras-sociales/${otra.body.id}`, cookie, {
      nombre: 'swiss MEDICAL',
    });
    expect(renombrada.status).toBe(409);
    expect(renombrada.body.error.code).toBe('OBRA_SOCIAL_DUPLICADA');
  });

  it('DELETE es una baja lógica y se puede revertir con PATCH', async () => {
    const { body } = await llamar('post', '/obras-sociales', cookie, { nombre: 'PAMI' });

    const baja = await llamar('delete', `/obras-sociales/${body.id}`, cookie);
    expect(baja.status).toBe(200);
    expect(baja.body.activa).toBe(false);
    expect((await migrador.query('SELECT 1 FROM obra_social')).rowCount).toBe(1);

    const activas = await llamar('get', '/obras-sociales?activa=true', cookie);
    expect(activas.body.data).toHaveLength(0);
    const inactivas = await llamar('get', '/obras-sociales?activa=false', cookie);
    expect(inactivas.body.data).toHaveLength(1);

    const reactivada = await llamar('patch', `/obras-sociales/${body.id}`, cookie, {
      activa: true,
    });
    expect(reactivada.body.activa).toBe(true);
  });

  it('filtra por texto sin tildes ni mayúsculas, pagina y trata % y _ como texto', async () => {
    for (const nombre of ['Galeno', 'Medifé', 'OSECAC', '100% Salud', 'Plan_B']) {
      await llamar('post', '/obras-sociales', cookie, { nombre }).expect(201);
    }
    const nombres = (res: { body: { data: { nombre: string }[] } }) =>
      res.body.data.map((fila) => fila.nombre);

    expect(nombres(await llamar('get', '/obras-sociales?q=MEDIFE', cookie))).toEqual(['Medifé']);
    expect(nombres(await llamar('get', '/obras-sociales?q=%25', cookie))).toEqual(['100% Salud']);
    expect(nombres(await llamar('get', '/obras-sociales?q=l_n', cookie))).toEqual([]);
    expect(nombres(await llamar('get', '/obras-sociales?q=plan_', cookie))).toEqual(['Plan_B']);

    const pagina = await llamar('get', '/obras-sociales?page_size=2&page=2', cookie);
    expect(pagina.body.meta).toEqual({ page: 2, page_size: 2, total: 5 });
    expect(nombres(pagina)).toEqual(['Medifé', 'OSECAC']);
    const descendente = await llamar('get', '/obras-sociales?dir=desc&page_size=1', cookie);
    expect(nombres(descendente)).toEqual(['Plan_B']);
  });

  it('valida los datos y rechaza campos desconocidos y parámetros peligrosos', async () => {
    for (const cuerpo of [
      {},
      { nombre: '   ' },
      { nombre: 'x'.repeat(121) },
      { nombre: 'A', activa: false },
    ]) {
      const res = await llamar('post', '/obras-sociales', cookie, cuerpo);
      expect(res.status, JSON.stringify(cuerpo)).toBe(400);
      expect(res.body.error.code).toBe('VALIDACION');
    }
    const { body } = await llamar('post', '/obras-sociales', cookie, { nombre: 'OSDE' });
    for (const cuerpo of [{}, { id: 5 }, { nombre: '' }]) {
      expect((await llamar('patch', `/obras-sociales/${body.id}`, cookie, cuerpo)).status).toBe(
        400,
      );
    }
    for (const consulta of [
      'dir=asc;DROP TABLE obra_social',
      'orden=nombre',
      'page_size=500',
      'activa=si',
    ]) {
      const res = await llamar(
        'get',
        `/obras-sociales?${encodeURIComponent(consulta).replace(/%3D/g, '=')}`,
        cookie,
      );
      expect(res.status, consulta).toBe(400);
    }
    expect((await migrador.query('SELECT 1 FROM obra_social')).rowCount).toBe(1);
  });

  it('responde 404 para una obra social inexistente y 400 para un id inválido', async () => {
    expect((await llamar('patch', '/obras-sociales/999999', cookie, { nombre: 'X' })).status).toBe(
      404,
    );
    expect((await llamar('delete', '/obras-sociales/999999', cookie)).status).toBe(404);
    expect((await llamar('patch', '/obras-sociales/abc', cookie, { nombre: 'X' })).status).toBe(
      400,
    );
  });
});
