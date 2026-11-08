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

describe.skipIf(!config)('consulta de la auditoría (PostgreSQL real)', () => {
  let creada: ReturnType<typeof crearAppDePrueba>;
  let migrador: pg.Pool;
  let llamar: ReturnType<typeof crearLlamador>;
  let cookieAdmin: string;
  let cookieProfesional: string;
  let idAdmin: number;
  let idProfesional: number;

  beforeAll(async () => {
    creada = crearAppDePrueba(config!);
    migrador = poolMigrador(config!);
    llamar = crearLlamador(creada.app);
    await limpiarDatos(migrador);
    idAdmin = await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
    idProfesional = await insertarUsuario(migrador, { nombre_usuario: 'profe' });
    cookieAdmin = await iniciarSesionComo(creada.app, 'jefa');
    cookieProfesional = await iniciarSesionComo(creada.app, 'profe');
  });
  afterAll(async () => {
    await creada.pool.end();
    await migrador.end();
  });
  beforeEach(async () => {
    await limpiarDatosClinicos(migrador);
  });

  /** Inserta un registro de auditoría con fecha fija (horas en UTC; Córdoba es UTC-3). */
  async function registro(datos: {
    fecha: string;
    idUsuario: number | null;
    accion: string;
    entidad?: string;
    entidadId?: number;
    ip?: string;
    detalle?: object;
  }) {
    const { rows } = await migrador.query<{ id: number }>(
      `INSERT INTO auditoria (fecha, id_usuario, accion, entidad, entidad_id, ip, detalle)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        datos.fecha,
        datos.idUsuario,
        datos.accion,
        datos.entidad ?? null,
        datos.entidadId ?? null,
        datos.ip ?? null,
        datos.detalle ? JSON.stringify(datos.detalle) : null,
      ],
    );
    return rows[0]!.id;
  }

  async function sembrar() {
    return {
      a1: await registro({
        fecha: '2024-03-10T15:00:00Z',
        idUsuario: idAdmin,
        accion: 'paciente_crear',
        entidad: 'paciente',
        entidadId: 5,
        ip: '10.0.0.1',
        detalle: { campos: ['nombre_completo'] },
      }),
      a2: await registro({
        fecha: '2024-03-11T15:00:00Z',
        idUsuario: idProfesional,
        accion: 'ver_paciente',
        entidad: 'paciente',
        entidadId: 5,
      }),
      a3: await registro({
        fecha: '2024-03-12T15:00:00Z',
        idUsuario: idProfesional,
        accion: 'consulta_crear',
        entidad: 'consulta',
        entidadId: 9,
        detalle: { id_paciente: 5 },
      }),
      // 22:00 del 31/03 en Córdoba (ya es 01/04 en UTC)
      a4: await registro({
        fecha: '2024-04-01T01:00:00Z',
        idUsuario: idAdmin,
        accion: 'login_ok',
        entidad: 'usuario',
        entidadId: idAdmin,
      }),
      a5: await registro({
        fecha: '2024-02-01T15:00:00Z',
        idUsuario: null,
        accion: 'login_fallido',
        ip: '203.0.113.7',
        detalle: { motivo: 'usuario_inexistente' },
      }),
    };
  }
  const ids = (res: { body: { data: { id: number }[] } }) => res.body.data.map((fila) => fila.id);
  const listar = async (consulta = '') =>
    ids(await llamar('get', `/auditoria?${consulta}`, cookieAdmin));

  describe('permisos', () => {
    const rutas = ['/auditoria', '/auditoria/acciones', '/auditoria/1'];

    it('sin sesión: 401; profesional: 403; el rechazo no deja registro de lectura', async () => {
      await sembrar();
      for (const ruta of rutas) {
        expect((await llamar('get', ruta)).status, ruta).toBe(401);
        const res = await llamar('get', ruta, cookieProfesional);
        expect(res.status, ruta).toBe(403);
        expect(res.body.error.code).toBe('PROHIBIDO');
      }
      expect(await auditoriaDe(migrador, 'auditoria_ver')).toHaveLength(0);
    });

    it('la auditoría es de solo lectura: no hay rutas para crear, modificar ni borrar', async () => {
      const id = await registro({
        fecha: '2024-03-10T15:00:00Z',
        idUsuario: idAdmin,
        accion: 'login_ok',
      });
      for (const [metodo, ruta] of [
        ['post', '/auditoria'],
        ['post', `/auditoria/${id}`],
        ['patch', `/auditoria/${id}`],
        ['delete', `/auditoria/${id}`],
      ] as const) {
        expect((await llamar(metodo, ruta, cookieAdmin, {})).status, `${metodo} ${ruta}`).toBe(404);
      }
      expect((await migrador.query('SELECT 1 FROM auditoria WHERE id = $1', [id])).rowCount).toBe(
        1,
      );
    });
  });

  describe('listado', () => {
    it('trae todos los registros, del más reciente al más antiguo, con usuario, ip y detalle', async () => {
      const { a1, a2, a3, a4, a5 } = await sembrar();
      const res = await llamar('get', '/auditoria', cookieAdmin);
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([a4, a3, a2, a1, a5]);
      expect(res.body.meta).toEqual({ page: 1, page_size: 25, total: 5 });

      const alta = res.body.data.find((fila: { id: number }) => fila.id === a1);
      expect(alta).toEqual({
        id: a1,
        fecha: '2024-03-10T15:00:00.000Z',
        usuario: { id: idAdmin, nombre_usuario: 'jefa', nombre_completo: 'Usuario jefa' },
        accion: 'paciente_crear',
        entidad: 'paciente',
        entidad_id: 5,
        ip: '10.0.0.1',
        detalle: { campos: ['nombre_completo'] },
      });
      const anonimo = res.body.data.find((fila: { id: number }) => fila.id === a5);
      expect(anonimo).toMatchObject({
        usuario: null,
        entidad: null,
        entidad_id: null,
        ip: '203.0.113.7',
      });
    });

    it('filtra por usuario, acción, entidad y entidad_id', async () => {
      const { a1, a2, a3, a4 } = await sembrar();
      expect(await listar(`id_usuario=${idProfesional}`)).toEqual([a3, a2]);
      expect(await listar(`id_usuario=${idAdmin}`)).toEqual([a4, a1]);
      expect(await listar('accion=ver_paciente')).toEqual([a2]);
      expect(await listar('entidad=paciente')).toEqual([a2, a1]);
      expect(await listar('entidad=paciente&entidad_id=5')).toEqual([a2, a1]);
      expect(await listar('entidad_id=9')).toEqual([a3]);
      expect(await listar(`id_usuario=${idProfesional}&accion=consulta_crear`)).toEqual([a3]);
      expect(await listar('accion=archivo_baja')).toEqual([]);
    });

    it('filtra por rango de fechas en días completos de Córdoba', async () => {
      const { a1, a2, a3, a4, a5 } = await sembrar();
      expect(await listar('desde=2024-03-11&hasta=2024-03-12')).toEqual([a3, a2]);
      expect(await listar('desde=2024-03-12')).toEqual([a4, a3]);
      expect(await listar('hasta=2024-02-29')).toEqual([a5]);
      // a4 es del 31/03 a las 22:00 en Córdoba aunque en UTC ya sea abril
      expect(await listar('hasta=2024-03-31')).toEqual([a4, a3, a2, a1, a5]);
      expect(await listar('desde=2024-04-01')).toEqual([]);
    });

    it('pagina (hasta 200 por página)', async () => {
      await sembrar();
      const pagina2 = await llamar('get', '/auditoria?page_size=2&page=2', cookieAdmin);
      expect(pagina2.body.meta).toEqual({ page: 2, page_size: 2, total: 5 });
      expect(pagina2.body.data).toHaveLength(2);
      expect((await llamar('get', '/auditoria?page_size=200', cookieAdmin)).status).toBe(200);
      expect((await llamar('get', '/auditoria?page_size=201', cookieAdmin)).status).toBe(400);
    });

    it('rechaza filtros inválidos o con intento de inyección', async () => {
      await sembrar();
      for (const consulta of [
        "accion=x'; DROP TABLE auditoria;--",
        'accion=VER_PACIENTE',
        'accion=a b',
        'entidad=paciente;DELETE',
        'entidad_id=abc',
        'id_usuario=0',
        'id_usuario=1;--',
        'desde=ayer',
        'desde=2024-05-02&hasta=2024-05-01',
        'page=0',
        'orden=fecha',
        'detalle=algo',
      ]) {
        const res = await llamar(
          'get',
          `/auditoria?${encodeURIComponent(consulta).replace(/%3D/g, '=').replace(/%26/g, '&')}`,
          cookieAdmin,
        );
        expect(res.status, consulta).toBe(400);
        expect(res.body.error.code).toBe('VALIDACION');
      }
      expect((await migrador.query('SELECT 1 FROM auditoria')).rowCount).toBe(5);
    });

    it('listar no registra una lectura de auditoría', async () => {
      await sembrar();
      await listar();
      await llamar('get', '/auditoria/acciones', cookieAdmin).expect(200);
      expect(await auditoriaDe(migrador, 'auditoria_ver')).toHaveLength(0);
    });
  });

  describe('acciones existentes', () => {
    it('devuelve las acciones distintas, ordenadas, para armar filtros', async () => {
      await sembrar();
      await registro({ fecha: '2024-03-13T15:00:00Z', idUsuario: idAdmin, accion: 'ver_paciente' });
      const res = await llamar('get', '/auditoria/acciones', cookieAdmin);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: ['consulta_crear', 'login_fallido', 'login_ok', 'paciente_crear', 'ver_paciente'],
      });
    });

    it('sin registros devuelve una lista vacía (y "acciones" no se confunde con un id)', async () => {
      const res = await llamar('get', '/auditoria/acciones', cookieAdmin);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [] });
    });
  });

  describe('detalle de un registro', () => {
    it('devuelve el registro y deja constancia de quién lo abrió (auditoria_ver)', async () => {
      const { a1 } = await sembrar();
      const res = await llamar('get', `/auditoria/${a1}`, cookieAdmin);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: a1,
        accion: 'paciente_crear',
        usuario: { id: idAdmin, nombre_usuario: 'jefa' },
        ip: '10.0.0.1',
        detalle: { campos: ['nombre_completo'] },
      });

      const [lectura] = await auditoriaDe(migrador, 'auditoria_ver');
      expect(lectura).toMatchObject({ id_usuario: idAdmin, entidad: 'auditoria', entidad_id: a1 });
    });

    it('404 si no existe, 400 si el id es inválido; ninguno deja registro', async () => {
      expect((await llamar('get', '/auditoria/999999', cookieAdmin)).status).toBe(404);
      expect((await llamar('get', '/auditoria/abc', cookieAdmin)).status).toBe(400);
      expect(await auditoriaDe(migrador, 'auditoria_ver')).toHaveLength(0);
    });
  });
});
