import type pg from 'pg';
import request from 'supertest';
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

const NOMBRE_PELIGROSO = '=HYPERLINK("http://malo";"x")';

describe.skipIf(!config)('reportes (PostgreSQL real)', () => {
  let creada: ReturnType<typeof crearAppDePrueba>;
  let conComa: ReturnType<typeof crearAppDePrueba>;
  let migrador: pg.Pool;
  let llamar: ReturnType<typeof crearLlamador>;
  let cookie: string;

  beforeAll(async () => {
    creada = crearAppDePrueba(config!);
    conComa = crearAppDePrueba(config!, { CSV_SEPARADOR: ',' });
    migrador = poolMigrador(config!);
    llamar = crearLlamador(creada.app);
    await limpiarDatos(migrador);
    await insertarUsuario(migrador, { nombre_usuario: 'profe' });
    cookie = await iniciarSesionComo(creada.app, 'profe');
  });
  afterAll(async () => {
    await creada.pool.end();
    await conComa.pool.end();
    await migrador.end();
  });
  beforeEach(async () => {
    await limpiarDatosClinicos(migrador);
  });

  // --- datos de prueba (horas en UTC; Córdoba es UTC-3 todo el año) ---
  async function obraSocial(nombre: string) {
    const { rows } = await migrador.query<{ id: number }>(
      'INSERT INTO obra_social (nombre) VALUES ($1) RETURNING id',
      [nombre],
    );
    return rows[0]!.id;
  }
  async function paciente(
    nombre: string,
    creado: string,
    opciones: { activo?: boolean; idObraSocial?: number } = {},
  ) {
    const { rows } = await migrador.query<{ id: number }>(
      `INSERT INTO paciente (nombre_completo, creado_en, activo, id_obra_social)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [nombre, creado, opciones.activo ?? true, opciones.idObraSocial ?? null],
    );
    return rows[0]!.id;
  }
  async function consulta(idPaciente: number, fecha: string, anulada = false) {
    const { rows } = await migrador.query<{ id: number }>(
      'INSERT INTO consulta (id_paciente, fecha_consulta, anulada) VALUES ($1, $2, $3) RETURNING id',
      [idPaciente, fecha, anulada],
    );
    await migrador.query(
      "INSERT INTO consulta_contenido (id_consulta, version, contenido, creado_en) VALUES ($1, 0, 'texto', $2)",
      [rows[0]!.id, fecha],
    );
    return rows[0]!.id;
  }
  async function edicion(idConsulta: number, version: number, creado: string) {
    await migrador.query(
      "INSERT INTO consulta_contenido (id_consulta, version, contenido, creado_en) VALUES ($1, $2, 'editado', $3)",
      [idConsulta, version, creado],
    );
  }

  /** Pacientes, consultas y ediciones repartidos entre enero y marzo de 2024. */
  async function sembrarSerie() {
    const osde = await obraSocial('OSDE');
    const pami = await obraSocial('PAMI');
    const p1 = await paciente('Ana Pérez', '2024-01-10T15:00:00Z', { idObraSocial: osde });
    const p2 = await paciente('Beto Gómez', '2024-01-20T15:00:00Z', { idObraSocial: osde });
    await paciente('Carla Ruiz', '2024-03-05T15:00:00Z');
    // 23:30 del 31/03 en Córdoba: ya es abril en UTC, pero cuenta como marzo
    const p4 = await paciente(NOMBRE_PELIGROSO, '2024-04-01T02:30:00Z');
    await paciente('Inactivo Uno', '2024-02-15T15:00:00Z', { activo: false, idObraSocial: pami });

    const c1 = await consulta(p1, '2024-01-10T15:00:00Z');
    const c2 = await consulta(p1, '2024-01-20T15:00:00Z');
    const c3 = await consulta(p2, '2024-03-10T15:00:00Z');
    await consulta(p1, '2024-02-10T15:00:00Z', true); // anulada: no cuenta
    await consulta(p4, '2024-04-01T01:00:00Z'); // 22:00 del 31/03 en Córdoba: marzo
    await consulta(p4, '2024-03-12T15:00:00Z');
    await consulta(p4, '2024-03-13T15:00:00Z');

    await edicion(c1, 1, '2024-01-25T15:00:00Z');
    await edicion(c1, 2, '2024-01-26T15:00:00Z');
    await edicion(c2, 1, '2024-01-28T15:00:00Z');
    await edicion(c3, 1, '2024-03-20T15:00:00Z');
    return { p1, p2, p4, osde };
  }

  const datos = async (ruta: string) => {
    const res = await llamar('get', ruta, cookie);
    expect(res.status, `${ruta}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body.data;
  };

  describe('acceso y validación', () => {
    const rutas = [
      '/reportes/resumen',
      '/reportes/consultas-por-mes',
      '/reportes/pacientes-nuevos-por-mes',
      '/reportes/ediciones-por-mes',
      '/reportes/pacientes-por-obra-social',
      '/reportes/consultas-por-paciente',
    ];

    it('exige sesión; cualquier rol autenticado puede ver los reportes', async () => {
      for (const ruta of rutas) {
        expect((await llamar('get', ruta)).status, ruta).toBe(401);
        expect((await llamar('get', ruta, cookie)).status, ruta).toBe(200);
      }
    });

    it('rechaza formatos, fechas y parámetros inválidos', async () => {
      for (const consulta of [
        '/reportes/consultas-por-mes?formato=xml',
        '/reportes/consultas-por-mes?formato=CSV',
        '/reportes/consultas-por-mes?desde=2024-02-30',
        '/reportes/consultas-por-mes?desde=ayer',
        '/reportes/consultas-por-mes?hasta=2200-01-01',
        '/reportes/consultas-por-mes?desde=1800-01-01',
        '/reportes/consultas-por-mes?desde=2024-05-02&hasta=2024-05-01',
        '/reportes/consultas-por-mes?mes=2024-01',
        '/reportes/consultas-por-mes?desde=2024-01-01;DROP TABLE consulta',
        '/reportes/ediciones-por-mes?limit=5',
        '/reportes/consultas-por-paciente?limit=0',
        '/reportes/consultas-por-paciente?limit=101',
        '/reportes/consultas-por-paciente?limit=abc',
        '/reportes/resumen?desde=2024-01-01',
        '/reportes/pacientes-por-obra-social?formato=pdf',
      ]) {
        const res = await llamar('get', consulta.replace(/;/g, '%3B'), cookie);
        expect(res.status, consulta).toBe(400);
        expect(res.body.error.code).toBe('VALIDACION');
      }
    });
  });

  describe('series mensuales', () => {
    it('consultas por mes: sin anuladas, mes de Córdoba y meses vacíos en cero', async () => {
      await sembrarSerie();
      expect(await datos('/reportes/consultas-por-mes')).toEqual([
        { mes: '2024-01-01', consultas: 2 },
        { mes: '2024-02-01', consultas: 0 },
        { mes: '2024-03-01', consultas: 4 },
      ]);
    });

    it('filtra por días completos dentro de un mes (hora de Córdoba)', async () => {
      await sembrarSerie();
      expect(await datos('/reportes/consultas-por-mes?desde=2024-01-15&hasta=2024-03-15')).toEqual([
        { mes: '2024-01-01', consultas: 1 },
        { mes: '2024-02-01', consultas: 0 },
        { mes: '2024-03-01', consultas: 3 },
      ]);
      expect(await datos('/reportes/consultas-por-mes?desde=2024-03-01')).toEqual([
        { mes: '2024-03-01', consultas: 4 },
      ]);
      expect(await datos('/reportes/consultas-por-mes?hasta=2024-01-31')).toEqual([
        { mes: '2024-01-01', consultas: 2 },
      ]);
      // El 31/03 a las 22:00 (Córdoba) pertenece a ese día aunque en UTC sea 01/04
      expect(await datos('/reportes/consultas-por-mes?desde=2024-03-31&hasta=2024-03-31')).toEqual([
        { mes: '2024-03-01', consultas: 1 },
      ]);
    });

    it('con un rango pedido sin datos devuelve los meses en cero; sin rango ni datos, vacío', async () => {
      expect(await datos('/reportes/consultas-por-mes')).toEqual([]);
      expect(await datos('/reportes/consultas-por-mes?desde=2025-01-10&hasta=2025-03-02')).toEqual([
        { mes: '2025-01-01', consultas: 0 },
        { mes: '2025-02-01', consultas: 0 },
        { mes: '2025-03-01', consultas: 0 },
      ]);
    });

    it('pacientes nuevos por mes (incluye inactivos y respeta el mes de Córdoba)', async () => {
      await sembrarSerie();
      expect(await datos('/reportes/pacientes-nuevos-por-mes')).toEqual([
        { mes: '2024-01-01', pacientes_nuevos: 2 },
        { mes: '2024-02-01', pacientes_nuevos: 1 },
        { mes: '2024-03-01', pacientes_nuevos: 2 },
      ]);
      expect(
        await datos('/reportes/pacientes-nuevos-por-mes?desde=2024-02-01&hasta=2024-02-29'),
      ).toEqual([{ mes: '2024-02-01', pacientes_nuevos: 1 }]);
    });

    it('ediciones por mes con la cantidad de consultas distintas modificadas', async () => {
      await sembrarSerie();
      expect(await datos('/reportes/ediciones-por-mes')).toEqual([
        { mes: '2024-01-01', ediciones: 3, consultas_modificadas: 2 },
        { mes: '2024-02-01', ediciones: 0, consultas_modificadas: 0 },
        { mes: '2024-03-01', ediciones: 1, consultas_modificadas: 1 },
      ]);
      expect(await datos('/reportes/ediciones-por-mes?desde=2024-01-27&hasta=2024-01-31')).toEqual([
        { mes: '2024-01-01', ediciones: 1, consultas_modificadas: 1 },
      ]);
    });

    it('coinciden con las vistas reporte_* de la base', async () => {
      await sembrarSerie();
      const comparar = async (ruta: string, vista: string, columnas: string[]) => {
        const esperado = (
          await migrador.query(`SELECT mes::text AS mes, ${columnas.join(', ')} FROM ${vista}`)
        ).rows;
        const obtenido = (await datos(ruta)).filter((fila: Record<string, number>) =>
          columnas.some((columna) => fila[columna] !== 0),
        );
        expect(obtenido).toEqual(esperado);
      };
      await comparar('/reportes/consultas-por-mes', 'reporte_consultas_por_mes', ['consultas']);
      await comparar('/reportes/pacientes-nuevos-por-mes', 'reporte_pacientes_nuevos_por_mes', [
        'pacientes_nuevos',
      ]);
      await comparar('/reportes/ediciones-por-mes', 'reporte_ediciones_por_mes', [
        'ediciones',
        'consultas_modificadas',
      ]);
    });
  });

  describe('rankings y distribución', () => {
    it('pacientes por obra social: solo activos, con los que no tienen en una fila aparte', async () => {
      const { osde } = await sembrarSerie();
      expect(await datos('/reportes/pacientes-por-obra-social')).toEqual([
        { id_obra_social: osde, nombre: 'OSDE', cantidad: 2 },
        { id_obra_social: null, nombre: 'Sin obra social', cantidad: 2 },
      ]);
    });

    it('ranking de consultas por paciente, con límite y período', async () => {
      const { p1, p2, p4 } = await sembrarSerie();
      expect(await datos('/reportes/consultas-por-paciente')).toEqual([
        {
          id_paciente: p4,
          nombre_completo: NOMBRE_PELIGROSO,
          consultas: 3,
          ultima_consulta: '2024-04-01T01:00:00.000Z',
        },
        {
          id_paciente: p1,
          nombre_completo: 'Ana Pérez',
          consultas: 2,
          ultima_consulta: '2024-01-20T15:00:00.000Z',
        },
        {
          id_paciente: p2,
          nombre_completo: 'Beto Gómez',
          consultas: 1,
          ultima_consulta: '2024-03-10T15:00:00.000Z',
        },
      ]);
      const dos = await datos('/reportes/consultas-por-paciente?limit=2');
      expect(dos.map((fila: { id_paciente: number }) => fila.id_paciente)).toEqual([p4, p1]);
      const marzo = await datos(
        '/reportes/consultas-por-paciente?desde=2024-03-01&hasta=2024-03-31',
      );
      expect(
        marzo.map((fila: { id_paciente: number; consultas: number }) => [
          fila.id_paciente,
          fila.consultas,
        ]),
      ).toEqual([
        [p4, 3],
        [p2, 1],
      ]);
    });
  });

  describe('resumen', () => {
    it('devuelve los indicadores generales y del mes en curso', async () => {
      const p = await paciente('Ana', '2024-01-10T15:00:00Z');
      await paciente('Baja', '2024-01-11T15:00:00Z', { activo: false });
      await consulta(p, '2024-01-10T15:00:00Z'); // mes viejo: solo en el total
      await consulta(p, '2024-01-11T15:00:00Z', true); // anulada
      const ahora = new Date().toISOString();
      const delMes = await consulta(p, ahora);
      await consulta(p, ahora);
      await edicion(delMes, 1, ahora);
      await edicion(delMes, 2, '2024-02-01T15:00:00Z'); // edición vieja
      const archivo = (tipo: string, eliminado: boolean) =>
        migrador.query(
          `INSERT INTO paciente_archivo (id_paciente, tipo, nombre_original, mime_type, tamano_bytes,
                                         sha256, storage_key, eliminado)
           VALUES ($1, $2, 'x', 'image/png', 10, $3, $4, $5)`,
          [p, tipo, 'a'.repeat(64), `k/${Math.random()}`, eliminado],
        );
      await archivo('estudio', false);
      await archivo('ficha_antigua', false);
      await archivo('estudio', true); // eliminado: no cuenta

      const res = await llamar('get', '/reportes/resumen', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        pacientes_total: 2,
        pacientes_activos: 1,
        consultas_total: 3,
        consultas_del_mes: 2,
        ediciones_del_mes: 1,
        archivos_total: 2,
        archivos_estudios: 1,
        archivos_fichas_antiguas: 1,
      });
    });

    it('con la base vacía todo es cero', async () => {
      const res = await llamar('get', '/reportes/resumen', cookie);
      expect(Object.values(res.body)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });
  });

  describe('exportación CSV', () => {
    const descargar = async (ruta: string, app = creada.app) => {
      const res = await request(app).get(ruta).set('Cookie', cookie).responseType('blob');
      const cuerpo = Buffer.from(res.body as Buffer);
      return { res, cuerpo, texto: cuerpo.toString('utf8') };
    };

    it('es UTF-8 con BOM, separador ; y se descarga como archivo', async () => {
      await sembrarSerie();
      const { res, cuerpo, texto } = await descargar('/reportes/consultas-por-mes?formato=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="consultas-por-mes.csv"',
      );
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect([...cuerpo.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(texto.slice(1)).toBe(
        'mes;consultas\r\n2024-01-01;2\r\n2024-02-01;0\r\n2024-03-01;4\r\n',
      );
    });

    it('usa el separador configurado en CSV_SEPARADOR', async () => {
      await sembrarSerie();
      const { texto } = await descargar(
        '/reportes/consultas-por-mes?formato=csv&hasta=2024-01-31',
        conComa.app,
      );
      expect(texto.slice(1)).toBe('mes,consultas\r\n2024-01-01,2\r\n');
    });

    it('neutraliza las fórmulas de los datos y entrecomilla lo que lo necesita', async () => {
      const { p4 } = await sembrarSerie();
      const { texto } = await descargar('/reportes/consultas-por-paciente?formato=csv&limit=1');
      const [encabezado, fila] = texto.slice(1).split('\r\n');
      expect(encabezado).toBe('id_paciente;nombre_completo;consultas;ultima_consulta');
      // El nombre empezaba con "=": queda como texto ('=...), y por contener ; y " va entre comillas
      expect(fila).toBe(`${p4};"'=HYPERLINK(""http://malo"";""x"")";3;2024-04-01T01:00:00.000Z`);
    });

    it('todos los reportes se pueden exportar', async () => {
      await sembrarSerie();
      const casos: [string, string][] = [
        ['/reportes/resumen', 'indicador;valor'],
        ['/reportes/consultas-por-mes', 'mes;consultas'],
        ['/reportes/pacientes-nuevos-por-mes', 'mes;pacientes_nuevos'],
        ['/reportes/ediciones-por-mes', 'mes;ediciones;consultas_modificadas'],
        ['/reportes/pacientes-por-obra-social', 'id_obra_social;nombre;cantidad'],
        [
          '/reportes/consultas-por-paciente',
          'id_paciente;nombre_completo;consultas;ultima_consulta',
        ],
      ];
      for (const [ruta, encabezado] of casos) {
        const { res, texto } = await descargar(`${ruta}?formato=csv`);
        expect(res.status, ruta).toBe(200);
        expect(texto.slice(1).split('\r\n')[0], ruta).toBe(encabezado);
      }
      const { texto } = await descargar('/reportes/resumen?formato=csv');
      expect(texto.slice(1).split('\r\n').slice(0, 3)).toEqual([
        'indicador;valor',
        'pacientes_total;5',
        'pacientes_activos;4',
      ]);
    });
  });
});
