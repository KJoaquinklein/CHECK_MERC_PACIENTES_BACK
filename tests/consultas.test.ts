import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditoriaDe,
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

describe.skipIf(!config)('consultas y ediciones (PostgreSQL real)', () => {
  let poolDeLaApp: pg.Pool;
  let migrador: pg.Pool;
  let llamar: ReturnType<typeof crearLlamador>;
  let cookie: string;
  let idUsuario: number;

  beforeAll(async () => {
    const creada = crearAppDePrueba(config!);
    poolDeLaApp = creada.pool;
    migrador = poolMigrador(config!);
    llamar = crearLlamador(creada.app);
    await limpiarDatos(migrador);
    idUsuario = await insertarUsuario(migrador, { nombre_usuario: 'profe' });
    cookie = await iniciarSesionComo(creada.app, 'profe');
  });
  afterAll(async () => {
    await poolDeLaApp.end();
    await migrador.end();
  });
  beforeEach(async () => {
    await limpiarDatosClinicos(migrador);
  });

  // --- datos de prueba ---
  async function paciente(nombre = 'Ana Pérez', activo = true) {
    const { rows } = await migrador.query<{ id: number }>(
      'INSERT INTO paciente (nombre_completo, activo) VALUES ($1, $2) RETURNING id',
      [nombre, activo],
    );
    return rows[0]!.id;
  }
  /** Inserta una consulta directamente (permite fijar fecha, estado y marca de fecha estimada). */
  async function consultaDirecta(
    idPaciente: number,
    contenido: string,
    opciones: { fecha?: string; anulada?: boolean; estimada?: boolean } = {},
  ) {
    const { rows } = await migrador.query<{ id: number }>(
      `INSERT INTO consulta (id_paciente, fecha_consulta, anulada, fecha_estimada)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        idPaciente,
        opciones.fecha ?? '2024-03-10T15:00:00Z',
        opciones.anulada ?? false,
        opciones.estimada ?? false,
      ],
    );
    await migrador.query(
      'INSERT INTO consulta_contenido (id_consulta, version, contenido) VALUES ($1, 0, $2)',
      [rows[0]!.id, contenido],
    );
    return rows[0]!.id;
  }
  async function crearPorApi(
    idPaciente: number,
    contenido = 'Dolor de cabeza',
    extra: object = {},
  ) {
    const res = await llamar('post', '/consultas', cookie, {
      id_paciente: idPaciente,
      contenido,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body as { id: number };
  }
  const editar = (id: number, contenido: string, version_base: number, extra: object = {}) =>
    llamar('post', `/consultas/${id}/ediciones`, cookie, { contenido, version_base, ...extra });
  const contarVersiones = async (id: number) =>
    (
      await migrador.query('SELECT count(*) AS n FROM consulta_contenido WHERE id_consulta = $1', [
        id,
      ])
    ).rows[0].n;
  const ids = (res: { body: { data: { id: number }[] } }) => res.body.data.map((fila) => fila.id);

  describe('acceso', () => {
    it('exige sesión en todas las rutas', async () => {
      for (const [metodo, ruta] of [
        ['get', '/consultas'],
        ['post', '/consultas'],
        ['get', '/consultas/1'],
        ['get', '/consultas/1/versiones'],
        ['get', '/consultas/1/versiones/0'],
        ['post', '/consultas/1/ediciones'],
        ['patch', '/consultas/1'],
        ['delete', '/consultas/1'],
        ['post', '/consultas/1/restaurar'],
      ] as const) {
        expect((await llamar(metodo, ruta)).status, `${metodo} ${ruta}`).toBe(401);
      }
    });
  });

  describe('crear', () => {
    it('crea la consulta y su versión 0 en una transacción, y la audita sin el texto clínico', async () => {
      const idPaciente = await paciente();
      const res = await llamar('post', '/consultas', cookie, {
        id_paciente: idPaciente,
        contenido: '   Paciente refiere cefalea.  ',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id_paciente: idPaciente,
        paciente: { id: idPaciente, nombre_completo: 'Ana Pérez' },
        contenido: 'Paciente refiere cefalea.',
        version_actual: 0,
        fue_editada: false,
        total_versiones: 1,
        anulada: false,
        fecha_estimada: false,
        creada_por: { id: idUsuario },
        editado_por: { id: idUsuario },
      });
      expect(Math.abs(Date.now() - new Date(res.body.fecha_consulta).getTime())).toBeLessThan(
        60_000,
      );

      const { rows } = await migrador.query('SELECT version FROM consulta_contenido');
      expect(rows).toEqual([{ version: 0 }]);
      const [registro] = await auditoriaDe(migrador, 'consulta_crear');
      expect(registro).toMatchObject({
        id_usuario: idUsuario,
        entidad: 'consulta',
        entidad_id: res.body.id,
      });
      expect(registro.detalle).toEqual({ id_paciente: idPaciente });
      expect(JSON.stringify(registro)).not.toContain('cefalea');
    });

    it('acepta una fecha clínica con zona horaria', async () => {
      const idPaciente = await paciente();
      const res = await llamar('post', '/consultas', cookie, {
        id_paciente: idPaciente,
        contenido: 'Control',
        fecha_consulta: '2024-05-10T15:30:00-03:00',
      });
      expect(res.status).toBe(201);
      expect(res.body.fecha_consulta).toBe('2024-05-10T18:30:00.000Z');
    });

    it('valida los datos de entrada', async () => {
      const idPaciente = await paciente();
      const futuro = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const invalidos: object[] = [
        {},
        { id_paciente: idPaciente },
        { id_paciente: idPaciente, contenido: '   ' },
        { id_paciente: idPaciente, contenido: 'a'.repeat(100_001) },
        { id_paciente: idPaciente, contenido: 'x', fecha_consulta: futuro },
        { id_paciente: idPaciente, contenido: 'x', fecha_consulta: '2024-05-10T15:30:00' },
        { id_paciente: idPaciente, contenido: 'x', fecha_consulta: '2024-05-10' },
        { id_paciente: idPaciente, contenido: 'x', fecha_consulta: '1850-01-01T00:00:00Z' },
        { id_paciente: 'x', contenido: 'x' },
        { id_paciente: 0, contenido: 'x' },
        { id_paciente: idPaciente, contenido: 'x', anulada: true },
        { id_paciente: idPaciente, contenido: 'x', version: 5 },
      ];
      for (const cuerpo of invalidos) {
        const res = await llamar('post', '/consultas', cookie, cuerpo);
        expect(res.status, JSON.stringify(cuerpo).slice(0, 80)).toBe(400);
        expect(res.body.error.code).toBe('VALIDACION');
      }
      expect((await migrador.query('SELECT 1 FROM consulta')).rowCount).toBe(0);
    });

    it('admite 100.000 caracteres aunque pesen más de 100 KB, y corta cuerpos de más de 450 KB', async () => {
      const idPaciente = await paciente();
      const larga = 'ñ'.repeat(100_000); // ~200 KB en JSON
      const ok = await llamar('post', '/consultas', cookie, {
        id_paciente: idPaciente,
        contenido: larga,
      });
      expect(ok.status).toBe(201);
      expect(ok.body.contenido).toHaveLength(100_000);

      const enorme = await llamar('post', '/consultas', cookie, {
        id_paciente: idPaciente,
        contenido: 'ñ'.repeat(250_000),
      });
      expect(enorme.status).toBe(413);
      expect((await migrador.query('SELECT 1 FROM consulta')).rowCount).toBe(1);
    });

    it('no registra consultas para un paciente inexistente ni dado de baja', async () => {
      const baja = await paciente('Baja', false);
      const inexistente = await llamar('post', '/consultas', cookie, {
        id_paciente: 999999,
        contenido: 'x',
      });
      expect(inexistente.status).toBe(422);
      expect(inexistente.body.error.code).toBe('PACIENTE_INVALIDO');

      const inactivo = await llamar('post', '/consultas', cookie, {
        id_paciente: baja,
        contenido: 'x',
      });
      expect(inactivo.status).toBe(409);
      expect(inactivo.body.error.code).toBe('PACIENTE_INACTIVO');
      expect((await migrador.query('SELECT 1 FROM consulta')).rowCount).toBe(0);
    });
  });

  describe('ediciones y versiones', () => {
    it('cada edición crea una versión nueva y nunca pisa la anterior', async () => {
      const idPaciente = await paciente();
      const { id } = await crearPorApi(idPaciente, 'Dolor de cabeza');

      const v1 = await editar(id, 'Dolor de cabeza intenso', 0, {
        motivo_edicion: '  Faltaba la intensidad ',
      });
      expect(v1.status).toBe(201);
      expect(v1.body).toMatchObject({
        version_actual: 1,
        fue_editada: true,
        total_versiones: 2,
        contenido: 'Dolor de cabeza intenso',
        motivo_edicion: 'Faltaba la intensidad',
        editado_por: { id: idUsuario, nombre_completo: 'Usuario profe' },
      });
      const v2 = await editar(id, 'Dolor de cabeza intenso con náuseas', 1);
      expect(v2.status).toBe(201);
      expect(v2.body).toMatchObject({
        version_actual: 2,
        total_versiones: 3,
        motivo_edicion: null,
      });

      const original = await migrador.query(
        'SELECT contenido FROM consulta_contenido WHERE version = 0',
      );
      expect(original.rows[0].contenido).toBe('Dolor de cabeza');
      expect(await contarVersiones(id)).toBe(3);
    });

    it('el historial completo se recupera con /versiones, en orden ascendente', async () => {
      const idPaciente = await paciente();
      const { id } = await crearPorApi(idPaciente, 'Versión cero');
      await editar(id, 'Versión uno', 0, { motivo_edicion: 'Corrección' }).expect(201);
      await editar(id, 'Versión dos', 1).expect(201);

      const historial = await llamar('get', `/consultas/${id}/versiones`, cookie);
      expect(historial.status).toBe(200);
      expect(historial.body).toHaveLength(3);
      expect(historial.body.map((v: { version: number }) => v.version)).toEqual([0, 1, 2]);
      expect(historial.body.map((v: { contenido: string }) => v.contenido)).toEqual([
        'Versión cero',
        'Versión uno',
        'Versión dos',
      ]);
      expect(historial.body[0].motivo_edicion).toBeNull();
      expect(historial.body[1].motivo_edicion).toBe('Corrección');
      expect(historial.body[1].usuario).toEqual({
        id: idUsuario,
        nombre_completo: 'Usuario profe',
      });
      expect(historial.body[1].creado_en).toEqual(expect.any(String));

      const una = await llamar('get', `/consultas/${id}/versiones/1`, cookie);
      expect(una.body).toMatchObject({ version: 1, contenido: 'Versión uno' });
      expect((await llamar('get', `/consultas/${id}/versiones/9`, cookie)).status).toBe(404);
      expect((await llamar('get', `/consultas/${id}/versiones/x`, cookie)).status).toBe(400);
      expect((await llamar('get', `/consultas/${id}/versiones/-1`, cookie)).status).toBe(400);
      expect((await llamar('get', '/consultas/999999/versiones', cookie)).status).toBe(404);
      expect((await llamar('get', '/consultas/999999/versiones/0', cookie)).status).toBe(404);

      const lecturas = await auditoriaDe(migrador, 'ver_consulta');
      expect(lecturas.map((l) => l.detalle)).toEqual([
        { vista: 'versiones' },
        { vista: 'version', version: 1 },
      ]);
    });

    it('la edición se audita con las versiones, sin texto clínico ni motivo', async () => {
      const { id } = await crearPorApi(await paciente(), 'Texto confidencial uno');
      await editar(id, 'Texto confidencial dos', 0, { motivo_edicion: 'Corrijo la dosis' }).expect(
        201,
      );
      const [registro] = await auditoriaDe(migrador, 'consulta_editar');
      expect(registro.entidad_id).toBe(id);
      expect(registro.detalle).toEqual({ version_anterior: 0, version_nueva: 1, con_motivo: true });
      expect(JSON.stringify(registro)).not.toContain('confidencial');
      expect(JSON.stringify(registro)).not.toContain('dosis');
    });

    it('responde 409 CONFLICTO_VERSION si version_base ya no es la vigente', async () => {
      const { id } = await crearPorApi(await paciente(), 'Uno');
      await editar(id, 'Dos', 0).expect(201);

      const res = await editar(id, 'Tres', 0);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICTO_VERSION');
      expect(res.body.error.details).toEqual([{ version_vigente: 1 }]);
      expect(await contarVersiones(id)).toBe(2);
      // Con la versión correcta sí se puede
      await editar(id, 'Tres', 1).expect(201);
    });

    it('dos o más ediciones simultáneas con la misma version_base: un solo 201, el resto 409', async () => {
      const { id } = await crearPorApi(await paciente(), 'Original');

      const respuestas = await Promise.all([
        editar(id, 'Edición A', 0),
        editar(id, 'Edición B', 0),
        editar(id, 'Edición C', 0),
      ]);
      expect(respuestas.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(
        respuestas
          .filter((r) => r.status === 409)
          .every((r) => r.body.error.code === 'CONFLICTO_VERSION'),
      ).toBe(true);

      const { rows } = await migrador.query(
        'SELECT version, contenido FROM consulta_contenido ORDER BY version',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ version: 0, contenido: 'Original' });
      const ganadora = respuestas.find((r) => r.status === 201)!;
      expect(rows[1].contenido).toBe(ganadora.body.contenido);
    });

    it('rechaza una edición idéntica a la vigente (422), también con espacios de más', async () => {
      const { id } = await crearPorApi(await paciente(), 'Mismo texto');
      for (const contenido of ['Mismo texto', '  Mismo texto \n']) {
        const res = await editar(id, contenido, 0);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('CONTENIDO_SIN_CAMBIOS');
      }
      expect(await contarVersiones(id)).toBe(1);
    });

    it('no se puede editar una consulta anulada hasta restaurarla', async () => {
      const { id } = await crearPorApi(await paciente(), 'Uno');
      await llamar('delete', `/consultas/${id}`, cookie).expect(200);

      const res = await editar(id, 'Dos', 0);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CONSULTA_ANULADA');
      expect(await contarVersiones(id)).toBe(1);

      await llamar('post', `/consultas/${id}/restaurar`, cookie).expect(200);
      await editar(id, 'Dos', 0).expect(201);
    });

    it('no se edita la consulta de un paciente dado de baja', async () => {
      const idPaciente = await paciente();
      const { id } = await crearPorApi(idPaciente, 'Uno');
      await migrador.query('UPDATE paciente SET activo = false WHERE id = $1', [idPaciente]);
      const res = await editar(id, 'Dos', 0);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PACIENTE_INACTIVO');
      // Leer sí se puede
      expect((await llamar('get', `/consultas/${id}`, cookie)).status).toBe(200);
    });

    it('valida el cuerpo de la edición y responde 404 si la consulta no existe', async () => {
      const { id } = await crearPorApi(await paciente(), 'Uno');
      const invalidos: object[] = [
        { contenido: 'Dos' },
        { contenido: 'Dos', version_base: -1 },
        { contenido: 'Dos', version_base: 0.5 },
        { contenido: 'Dos', version_base: '0' },
        { contenido: '   ', version_base: 0 },
        { contenido: 'Dos', version_base: 0, motivo_edicion: 'm'.repeat(501) },
        { contenido: 'Dos', version_base: 0, version: 7 },
        { contenido: 'Dos', version_base: 0, id_paciente: 3 },
      ];
      for (const cuerpo of invalidos) {
        const res = await llamar('post', `/consultas/${id}/ediciones`, cookie, cuerpo);
        expect(res.status, JSON.stringify(cuerpo)).toBe(400);
      }
      expect((await editar(999999, 'Dos', 0)).status).toBe(404);
      expect(
        (
          await llamar('post', '/consultas/abc/ediciones', cookie, {
            contenido: 'x',
            version_base: 0,
          })
        ).status,
      ).toBe(400);
      expect(await contarVersiones(id)).toBe(1);
    });
  });

  describe('lectura', () => {
    it('devuelve la versión vigente y registra ver_consulta', async () => {
      const { id } = await crearPorApi(await paciente(), 'Uno');
      await editar(id, 'Dos', 0).expect(201);

      const res = await llamar('get', `/consultas/${id}`, cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        contenido: 'Dos',
        version_actual: 1,
        total_versiones: 2,
        fue_editada: true,
      });
      const lecturas = await auditoriaDe(migrador, 'ver_consulta');
      expect(lecturas).toHaveLength(1);
      expect(lecturas[0]).toMatchObject({
        id_usuario: idUsuario,
        entidad: 'consulta',
        entidad_id: id,
      });
      expect(JSON.stringify(lecturas)).not.toContain('Dos');
    });

    it('responde 404 e id inválido sin auditar', async () => {
      expect((await llamar('get', '/consultas/999999', cookie)).status).toBe(404);
      expect((await llamar('get', '/consultas/abc', cookie)).status).toBe(400);
      expect(await auditoriaDe(migrador, 'ver_consulta')).toHaveLength(0);
    });
  });

  describe('listado', () => {
    let ana: number;
    let beto: number;
    let c1: number;
    let c2: number;
    let c3: number;
    let c4: number;

    beforeEach(async () => {
      ana = await paciente('Ana Pérez');
      beto = await paciente('Beto Gómez');
      c1 = await consultaDirecta(ana, 'Cefalea con náuseas', { fecha: '2024-03-10T15:00:00Z' });
      c2 = await consultaDirecta(ana, 'Control de presión arterial', {
        fecha: '2024-04-20T15:00:00Z',
      });
      c3 = await consultaDirecta(beto, 'Lumbalgia mecánica', { fecha: '2024-04-25T15:00:00Z' });
      c4 = await consultaDirecta(ana, 'Visita anulada', {
        fecha: '2024-05-01T15:00:00Z',
        anulada: true,
      });
      await editar(c2, 'Hipertensión controlada', 0).expect(201);
    });

    it('trae por defecto las no anuladas, de la más reciente a la más antigua', async () => {
      const res = await llamar('get', '/consultas', cookie);
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([c3, c2, c1]);
      expect(res.body.meta).toEqual({ page: 1, page_size: 25, total: 3 });
      expect(res.body.data[1]).toMatchObject({
        id: c2,
        id_paciente: ana,
        paciente: { id: ana, nombre_completo: 'Ana Pérez' },
        version_actual: 1,
        fue_editada: true,
        extracto: 'Hipertensión controlada',
        anulada: false,
      });
      expect(res.body.data[1]).not.toHaveProperty('contenido');
      expect(ids(await llamar('get', '/consultas?dir=asc', cookie))).toEqual([c1, c2, c3]);
      expect(ids(await llamar('get', '/consultas?incluir_anuladas=true', cookie))).toEqual([
        c4,
        c3,
        c2,
        c1,
      ]);
    });

    it('filtra por paciente, rango de fechas (hora de Córdoba) y si fue editada', async () => {
      expect(ids(await llamar('get', `/consultas?id_paciente=${ana}`, cookie))).toEqual([c2, c1]);
      expect(
        ids(await llamar('get', '/consultas?desde=2024-04-20&hasta=2024-04-20', cookie)),
      ).toEqual([c2]);
      expect(ids(await llamar('get', '/consultas?desde=2024-04-21', cookie))).toEqual([c3]);
      expect(ids(await llamar('get', '/consultas?hasta=2024-03-31', cookie))).toEqual([c1]);
      expect(ids(await llamar('get', '/consultas?editadas=true', cookie))).toEqual([c2]);
      expect(ids(await llamar('get', '/consultas?editadas=false', cookie))).toEqual([c3, c1]);
    });

    it('la búsqueda de texto usa solo la versión vigente, sin tildes ni mayúsculas', async () => {
      expect(ids(await llamar('get', '/consultas?q=NAUSEAS', cookie))).toEqual([c1]);
      expect(ids(await llamar('get', '/consultas?q=lumbalgia', cookie))).toEqual([c3]);
      expect(ids(await llamar('get', '/consultas?q=hipertension', cookie))).toEqual([c2]);
      // "presión arterial" estaba en la versión 0 de c2: ya no es la vigente
      expect(ids(await llamar('get', '/consultas?q=presion', cookie))).toEqual([]);
      expect(
        ids(
          await llamar(
            'get',
            `/consultas?q=${encodeURIComponent("'; DROP TABLE consulta; --")}`,
            cookie,
          ),
        ),
      ).toEqual([]);
      expect((await migrador.query('SELECT 1 FROM consulta')).rowCount).toBe(4);
    });

    it('trae un extracto de los primeros 200 caracteres y pagina', async () => {
      const larga = await consultaDirecta(ana, 'x'.repeat(500), { fecha: '2024-06-01T15:00:00Z' });
      const res = await llamar('get', '/consultas?page_size=2', cookie);
      expect(res.body.data[0].id).toBe(larga);
      expect(res.body.data[0].extracto).toHaveLength(200);
      expect(res.body.meta).toEqual({ page: 1, page_size: 2, total: 4 });
      expect(ids(await llamar('get', '/consultas?page_size=2&page=2', cookie))).toEqual([c2, c1]);
    });

    it('rechaza parámetros fuera de la lista blanca', async () => {
      for (const consulta of [
        'orden=password_hash',
        'orden=fecha_consulta;DROP TABLE consulta',
        'dir=desc;DELETE FROM consulta',
        'page_size=101',
        'page=0',
        'editadas=quizas',
        'incluir_anuladas=1',
        'desde=ayer',
        'desde=2024-05-02&hasta=2024-05-01',
        'id_paciente=1;--',
        `q=${'x'.repeat(201)}`,
        'desconocido=1',
      ]) {
        const res = await llamar(
          'get',
          `/consultas?${encodeURIComponent(consulta).replace(/%3D/g, '=')}`,
          cookie,
        );
        expect(res.status, consulta).toBe(400);
      }
    });
  });

  describe('cambio de fecha', () => {
    it('cambia solo la fecha, la audita con antes y después, y no crea versiones', async () => {
      const { id } = await crearPorApi(await paciente(), 'Texto', {
        fecha_consulta: '2024-05-10T15:00:00Z',
      });
      const res = await llamar('patch', `/consultas/${id}`, cookie, {
        fecha_consulta: '2024-05-09T12:00:00-03:00',
      });
      expect(res.status).toBe(200);
      expect(res.body.fecha_consulta).toBe('2024-05-09T15:00:00.000Z');
      expect(res.body.version_actual).toBe(0);
      expect(await contarVersiones(id)).toBe(1);

      const [registro] = await auditoriaDe(migrador, 'consulta_cambiar_fecha');
      expect(registro.entidad_id).toBe(id);
      expect(registro.detalle).toEqual({
        antes: '2024-05-10T15:00:00.000Z',
        despues: '2024-05-09T15:00:00.000Z',
      });
    });

    it('al fijar una fecha real deja de ser estimada', async () => {
      const id = await consultaDirecta(await paciente(), 'Migrada', { estimada: true });
      const antes = await llamar('get', `/consultas/${id}`, cookie);
      expect(antes.body.fecha_estimada).toBe(true);
      const res = await llamar('patch', `/consultas/${id}`, cookie, {
        fecha_consulta: '2023-01-15T12:00:00Z',
      });
      expect(res.body.fecha_estimada).toBe(false);
    });

    it('si la fecha es la misma no cambia ni audita', async () => {
      const { id } = await crearPorApi(await paciente(), 'Texto', {
        fecha_consulta: '2024-05-10T15:00:00Z',
      });
      await llamar('patch', `/consultas/${id}`, cookie, {
        fecha_consulta: '2024-05-10T12:00:00-03:00',
      }).expect(200);
      expect(await auditoriaDe(migrador, 'consulta_cambiar_fecha')).toHaveLength(0);
    });

    it('solo admite fecha_consulta válida; no permite tocar el contenido ni otros campos', async () => {
      const { id } = await crearPorApi(await paciente(), 'Texto');
      const futuro = new Date(Date.now() + 2 * 86_400_000).toISOString();
      for (const cuerpo of [
        {},
        { fecha_consulta: futuro },
        { fecha_consulta: '2024-05-10' },
        { contenido: 'otro' },
        { anulada: true },
        { fecha_consulta: '2024-05-10T15:00:00Z', id_paciente: 9 },
      ]) {
        expect(
          (await llamar('patch', `/consultas/${id}`, cookie, cuerpo)).status,
          JSON.stringify(cuerpo),
        ).toBe(400);
      }
      expect(
        (
          await llamar('patch', '/consultas/999999', cookie, {
            fecha_consulta: '2024-05-10T15:00:00Z',
          })
        ).status,
      ).toBe(404);
    });

    it('no se cambia la fecha de una consulta anulada', async () => {
      const { id } = await crearPorApi(await paciente(), 'Texto');
      await llamar('delete', `/consultas/${id}`, cookie).expect(200);
      const res = await llamar('patch', `/consultas/${id}`, cookie, {
        fecha_consulta: '2024-05-10T15:00:00Z',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CONSULTA_ANULADA');
    });
  });

  describe('anular y restaurar', () => {
    it('la baja lógica conserva todas las versiones; repetirla o restaurar dos veces no duplica auditoría', async () => {
      const idPaciente = await paciente();
      const { id } = await crearPorApi(idPaciente, 'Uno');
      await editar(id, 'Dos', 0).expect(201);

      const baja = await llamar('delete', `/consultas/${id}`, cookie);
      expect(baja.status).toBe(200);
      expect(baja.body).toMatchObject({ anulada: true, version_actual: 1, total_versiones: 2 });
      await llamar('delete', `/consultas/${id}`, cookie).expect(200);
      expect(await auditoriaDe(migrador, 'consulta_anular')).toHaveLength(1);
      expect(await contarVersiones(id)).toBe(2);

      // No aparece por defecto ni cuenta en la ficha del paciente, pero se puede pedir y leer
      expect(ids(await llamar('get', '/consultas', cookie))).toEqual([]);
      expect(ids(await llamar('get', '/consultas?incluir_anuladas=true', cookie))).toEqual([id]);
      const ficha = await llamar('get', `/pacientes/paciente/${idPaciente}`, cookie);
      expect(ficha.body.resumen.total_consultas).toBe(0);
      expect((await llamar('get', `/consultas/${id}`, cookie)).body.anulada).toBe(true);

      const restaurada = await llamar('post', `/consultas/${id}/restaurar`, cookie);
      expect(restaurada.status).toBe(200);
      expect(restaurada.body.anulada).toBe(false);
      await llamar('post', `/consultas/${id}/restaurar`, cookie).expect(200);
      expect(await auditoriaDe(migrador, 'consulta_restaurar')).toHaveLength(1);
      expect(ids(await llamar('get', '/consultas', cookie))).toEqual([id]);
    });

    it('responde 404 para consultas inexistentes', async () => {
      expect((await llamar('delete', '/consultas/999999', cookie)).status).toBe(404);
      expect((await llamar('post', '/consultas/999999/restaurar', cookie)).status).toBe(404);
    });

    it('no se anula ni restaura la consulta de un paciente dado de baja', async () => {
      const idPaciente = await paciente();
      const { id } = await crearPorApi(idPaciente, 'Uno');
      await migrador.query('UPDATE paciente SET activo = false WHERE id = $1', [idPaciente]);
      const res = await llamar('delete', `/consultas/${id}`, cookie);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PACIENTE_INACTIVO');
    });
  });
});
