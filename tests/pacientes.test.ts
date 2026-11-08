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

describe.skipIf(!config)('pacientes (PostgreSQL real)', () => {
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

  // --- datos de prueba insertados directamente, sin pasar por la API ---
  async function paciente(datos: Record<string, unknown> & { nombre_completo: string }) {
    const columnas = Object.keys(datos);
    const { rows } = await migrador.query<{ id: number }>(
      `INSERT INTO paciente (${columnas.join(', ')})
       VALUES (${columnas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(datos),
    );
    return rows[0]!.id;
  }
  async function obraSocial(nombre: string, activa = true) {
    const { rows } = await migrador.query<{ id: number }>(
      'INSERT INTO obra_social (nombre, activa) VALUES ($1, $2) RETURNING id',
      [nombre, activa],
    );
    return rows[0]!.id;
  }
  async function consulta(idPaciente: number, fecha: string, anulada = false) {
    const { rows } = await migrador.query<{ id: number }>(
      'INSERT INTO consulta (id_paciente, fecha_consulta, anulada) VALUES ($1, $2, $3) RETURNING id',
      [idPaciente, fecha, anulada],
    );
    await migrador.query(
      "INSERT INTO consulta_contenido (id_consulta, version, contenido) VALUES ($1, 0, 'texto')",
      [rows[0]!.id],
    );
  }
  async function archivo(idPaciente: number, eliminado = false) {
    await migrador.query(
      `INSERT INTO paciente_archivo (id_paciente, nombre_original, mime_type, tamano_bytes, sha256,
                                     storage_key, eliminado)
       VALUES ($1, 'a.pdf', 'application/pdf', 10, $2, $3, $4)`,
      [idPaciente, 'a'.repeat(64), `estudios/${idPaciente}/${Math.random()}.pdf`, eliminado],
    );
  }
  const nombres = (res: { body: { data: { nombre_completo: string }[] } }) =>
    res.body.data.map((fila) => fila.nombre_completo);

  describe('acceso', () => {
    it('exige sesión en todas las rutas', async () => {
      for (const [metodo, ruta] of [
        ['get', '/pacientes'],
        ['get', '/pacientes/conteo'],
        ['get', '/pacientes/resumen'],
        ['post', '/pacientes/paciente'],
        ['get', '/pacientes/paciente/1'],
        ['patch', '/pacientes/paciente/1'],
        ['delete', '/pacientes/paciente/1'],
        ['post', '/pacientes/paciente/1/reactivar'],
      ] as const) {
        expect((await llamar(metodo, ruta)).status, `${metodo} ${ruta}`).toBe(401);
      }
    });
  });

  describe('alta', () => {
    it('el alta rápida solo exige el nombre completo', async () => {
      const res = await llamar('post', '/pacientes/paciente', cookie, {
        nombre_completo: '  María López  ',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        nombre_completo: 'María López',
        dni: null,
        obra_social: null,
        activo: true,
      });
      expect(res.body).not.toHaveProperty('busqueda');
      expect(res.body).not.toHaveProperty('origen_uuid');

      const [registro] = await auditoriaDe(migrador, 'paciente_crear');
      expect(registro).toMatchObject({ id_usuario: idUsuario, entidad: 'paciente' });
      expect(registro.entidad_id).toBe(res.body.id);
      expect(registro.detalle).toEqual({ campos: ['nombre_completo'] });
    });

    it('guarda todos los datos y normaliza el DNI', async () => {
      const idOs = await obraSocial('OSDE');
      const res = await llamar('post', '/pacientes/paciente', cookie, {
        nombre_completo: 'José Ángel Pérez',
        dni: '30.123.456',
        fecha_nacimiento: '1985-07-14',
        telefono: '351 555-1234',
        email: 'jose@example.com',
        domicilio: 'Calle Falsa 123',
        id_obra_social: idOs,
        nro_afiliado: 'A-998',
        observaciones: 'Alérgico a la penicilina',
        telefono_2: 'no existe',
      });
      expect(res.status).toBe(400);

      const ok = await llamar('post', '/pacientes/paciente', cookie, {
        nombre_completo: 'José Ángel Pérez',
        dni: '30.123.456',
        fecha_nacimiento: '1985-07-14',
        telefono: '351 555-1234',
        email: 'jose@example.com',
        domicilio: 'Calle Falsa 123',
        id_obra_social: idOs,
        nro_afiliado: 'A-998',
        observaciones: 'Alérgico a la penicilina',
      });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({
        dni: '30123456',
        fecha_nacimiento: '1985-07-14',
        id_obra_social: idOs,
        obra_social: { id: idOs, nombre: 'OSDE', activa: true },
      });
      // La auditoría registra qué campos se cargaron, nunca sus valores
      const [registro] = await auditoriaDe(migrador, 'paciente_crear');
      expect(JSON.stringify(registro)).not.toContain('Alérgico');
      expect(JSON.stringify(registro)).not.toContain('30123456');
    });

    it('el DNI duplicado devuelve 409 DNI_DUPLICADO, aunque venga con puntos', async () => {
      await llamar('post', '/pacientes/paciente', cookie, {
        nombre_completo: 'A',
        dni: '30123456',
      }).expect(201);
      for (const dni of ['30123456', '30.123.456', ' 30 123 456 ']) {
        const res = await llamar('post', '/pacientes/paciente', cookie, {
          nombre_completo: 'B',
          dni,
        });
        expect(res.status, dni).toBe(409);
        expect(res.body.error.code).toBe('DNI_DUPLICADO');
      }
      // Sin DNI no hay conflicto, tantas veces como haga falta
      await llamar('post', '/pacientes/paciente', cookie, { nombre_completo: 'C' }).expect(201);
      await llamar('post', '/pacientes/paciente', cookie, {
        nombre_completo: 'D',
        dni: null,
      }).expect(201);
      expect((await migrador.query('SELECT 1 FROM paciente')).rowCount).toBe(3);
    });

    it('valida los datos de entrada', async () => {
      const mañana = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const invalidos: object[] = [
        {},
        { nombre_completo: '   ' },
        { nombre_completo: 'x'.repeat(201) },
        { nombre_completo: 'A', dni: 'abc' },
        { nombre_completo: 'A', dni: '12345' },
        { nombre_completo: 'A', dni: '1234567890' },
        { nombre_completo: 'A', fecha_nacimiento: mañana },
        { nombre_completo: 'A', fecha_nacimiento: '1850-01-01' },
        { nombre_completo: 'A', fecha_nacimiento: '2024-02-30' },
        { nombre_completo: 'A', fecha_nacimiento: '14/07/1985' },
        { nombre_completo: 'A', email: 'no-es-un-email' },
        { nombre_completo: 'A', id_obra_social: 'x' },
        { nombre_completo: 'A', activo: false },
        { nombre_completo: 'A', origen_uuid: 'x' },
        { nombre_completo: 'A', id: 5 },
      ];
      for (const cuerpo of invalidos) {
        const res = await llamar('post', '/pacientes/paciente', cookie, cuerpo);
        expect(res.status, JSON.stringify(cuerpo)).toBe(400);
        expect(res.body.error.code).toBe('VALIDACION');
      }
      expect((await migrador.query('SELECT 1 FROM paciente')).rowCount).toBe(0);
    });

    it('rechaza una obra social inexistente o dada de baja', async () => {
      const baja = await obraSocial('Vieja', false);
      const inexistente = await llamar('post', '/pacientes/paciente', cookie, {
        nombre_completo: 'A',
        id_obra_social: 999999,
      });
      expect(inexistente.status).toBe(422);
      expect(inexistente.body.error.code).toBe('OBRA_SOCIAL_INVALIDA');
      const inactiva = await llamar('post', '/pacientes/paciente', cookie, {
        nombre_completo: 'A',
        id_obra_social: baja,
      });
      expect(inactiva.status).toBe(422);
      expect(inactiva.body.error.code).toBe('OBRA_SOCIAL_INACTIVA');
      expect((await migrador.query('SELECT 1 FROM paciente')).rowCount).toBe(0);
    });
  });

  describe('búsqueda', () => {
    beforeEach(async () => {
      await paciente({
        nombre_completo: 'José Ángel Pérez',
        dni: '30123456',
        nro_afiliado: 'AF-778',
      });
      await paciente({
        nombre_completo: 'María López',
        telefono: '3515551234',
        email: 'maria@correo.com',
      });
      await paciente({ nombre_completo: '100% Real', dni: '40111222' });
      await paciente({ nombre_completo: 'Ana_B Gómez' });
    });
    const buscar = async (q: string) =>
      nombres(await llamar('get', `/pacientes?q=${encodeURIComponent(q)}`, cookie));

    it('"jose angel" encuentra a "José Ángel", sin importar tildes, mayúsculas ni orden', async () => {
      expect(await buscar('jose angel')).toEqual(['José Ángel Pérez']);
      expect(await buscar('JOSÉ ÁNGEL')).toEqual(['José Ángel Pérez']);
      expect(await buscar('angel jose')).toEqual(['José Ángel Pérez']);
      expect(await buscar('perez')).toEqual(['José Ángel Pérez']);
      expect(await buscar('jose lopez')).toEqual([]);
    });

    it('busca por DNI (con o sin puntos), afiliado, teléfono y email', async () => {
      expect(await buscar('30123456')).toEqual(['José Ángel Pérez']);
      expect(await buscar('30.123.456')).toEqual(['José Ángel Pérez']);
      expect(await buscar('af-778')).toEqual(['José Ángel Pérez']);
      expect(await buscar('555123')).toEqual(['María López']);
      expect(await buscar('MARIA@correo')).toEqual(['María López']);
    });

    it('% y _ del texto buscado son literales, no comodines', async () => {
      expect(await buscar('%')).toEqual(['100% Real']);
      expect(await buscar('_')).toEqual(['Ana_B Gómez']);
      expect(await buscar('a_b')).toEqual(['Ana_B Gómez']);
      expect(await buscar('j_se')).toEqual([]);
      expect(await buscar('\\')).toEqual([]);
    });

    it('un intento de inyección SQL es solo texto', async () => {
      expect(await buscar("'; DROP TABLE paciente; --")).toEqual([]);
      expect(await buscar("' OR '1'='1")).toEqual([]);
      expect((await migrador.query('SELECT 1 FROM paciente')).rowCount).toBe(4);
    });
  });

  describe('listado', () => {
    it('trae por defecto solo los activos, con obra social, última consulta y total', async () => {
      const os = await obraSocial('OSDE');
      const ana = await paciente({ nombre_completo: 'Ana', id_obra_social: os });
      await paciente({ nombre_completo: 'Beto' });
      await paciente({ nombre_completo: 'Carla', activo: false });
      await consulta(ana, '2024-03-01T12:00:00Z');
      await consulta(ana, '2024-05-10T12:00:00Z');
      await consulta(ana, '2024-09-09T12:00:00Z', true); // anulada: no cuenta

      const res = await llamar('get', '/pacientes', cookie);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ page: 1, page_size: 25, total: 2 });
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toMatchObject({
        nombre_completo: 'Ana',
        obra_social: { id: os, nombre: 'OSDE' },
        total_consultas: 2,
        ultima_consulta: '2024-05-10T12:00:00.000Z',
      });
      expect(res.body.data[1]).toMatchObject({
        nombre_completo: 'Beto',
        obra_social: null,
        total_consultas: 0,
        ultima_consulta: null,
      });
      expect(res.body.data[0]).not.toHaveProperty('busqueda');
      expect(res.body.data[0]).not.toHaveProperty('observaciones');

      expect(nombres(await llamar('get', '/pacientes?activo=false', cookie))).toEqual(['Carla']);
      expect(nombres(await llamar('get', '/pacientes?activo=todos', cookie))).toEqual([
        'Ana',
        'Beto',
        'Carla',
      ]);
    });

    it('filtra por obra social y por rango de fecha de alta (hora de Córdoba)', async () => {
      const os = await obraSocial('OSDE');
      await paciente({
        nombre_completo: 'Ana',
        id_obra_social: os,
        creado_en: '2024-03-10T12:00:00-03:00',
      });
      // 23:30 en Córdoba del 31/03 ya es 01/04 en UTC
      await paciente({ nombre_completo: 'Beto', creado_en: '2024-03-31T23:30:00-03:00' });
      await paciente({ nombre_completo: 'Carla', creado_en: '2024-04-01T00:30:00-03:00' });

      expect(nombres(await llamar('get', `/pacientes?id_obra_social=${os}`, cookie))).toEqual([
        'Ana',
      ]);
      expect(
        nombres(
          await llamar('get', '/pacientes?creado_desde=2024-03-31&creado_hasta=2024-03-31', cookie),
        ),
      ).toEqual(['Beto']);
      expect(nombres(await llamar('get', '/pacientes?creado_desde=2024-04-01', cookie))).toEqual([
        'Carla',
      ]);
      expect(nombres(await llamar('get', '/pacientes?creado_hasta=2024-03-31', cookie))).toEqual([
        'Ana',
        'Beto',
      ]);
      expect(
        (await llamar('get', '/pacientes?creado_desde=2024-04-02&creado_hasta=2024-04-01', cookie))
          .status,
      ).toBe(400);
    });

    it('ordena por nombre, dni, fecha de alta y última consulta, y pagina', async () => {
      const ana = await paciente({
        nombre_completo: 'Ana',
        dni: '30000002',
        creado_en: '2024-01-03T12:00:00Z',
      });
      const beto = await paciente({
        nombre_completo: 'beto',
        dni: '30000001',
        creado_en: '2024-01-02T12:00:00Z',
      });
      await paciente({ nombre_completo: 'Carla', creado_en: '2024-01-01T12:00:00Z' });
      await consulta(ana, '2024-02-01T12:00:00Z');
      await consulta(beto, '2024-06-01T12:00:00Z');

      const orden = async (consulta: string) =>
        nombres(await llamar('get', `/pacientes?${consulta}`, cookie));
      expect(await orden('orden=nombre')).toEqual(['Ana', 'beto', 'Carla']);
      expect(await orden('orden=nombre&dir=desc')).toEqual(['Carla', 'beto', 'Ana']);
      expect(await orden('orden=dni')).toEqual(['beto', 'Ana', 'Carla']); // sin DNI al final
      expect(await orden('orden=dni&dir=desc')).toEqual(['Ana', 'beto', 'Carla']);
      expect(await orden('orden=creado_en')).toEqual(['Carla', 'beto', 'Ana']);
      expect(await orden('orden=ultima_consulta&dir=desc')).toEqual(['beto', 'Ana', 'Carla']);
      expect(await orden('orden=ultima_consulta')).toEqual(['Ana', 'beto', 'Carla']); // sin consultas al final

      const pagina = await llamar('get', '/pacientes?page_size=2&page=2', cookie);
      expect(pagina.body.meta).toEqual({ page: 2, page_size: 2, total: 3 });
      expect(nombres(pagina)).toEqual(['Carla']);
    });

    it('ningún valor de orden, dir o paginación fuera de la lista blanca llega al SQL', async () => {
      await paciente({ nombre_completo: 'Ana' });
      for (const consulta of [
        'orden=nombre;DROP TABLE paciente',
        'orden=password_hash',
        'orden=busqueda',
        'orden=p.id',
        'dir=asc;DELETE FROM paciente',
        'dir=desc,id',
        'activo=quizas',
        'page=0',
        'page_size=101',
        'id_obra_social=1;--',
        'id_obra_social=-3',
        'desconocido=1',
      ]) {
        const res = await llamar(
          'get',
          `/pacientes?${encodeURIComponent(consulta).replace(/%3D/g, '=')}`,
          cookie,
        );
        expect(res.status, consulta).toBe(400);
        expect(res.body.error.code).toBe('VALIDACION');
      }
      expect((await migrador.query('SELECT 1 FROM paciente')).rowCount).toBe(1);
    });
  });

  describe('conteo y resumen', () => {
    it('el conteo acepta los mismos filtros del listado y coincide con su total', async () => {
      const os = await obraSocial('OSDE');
      await paciente({ nombre_completo: 'José Ángel', id_obra_social: os });
      await paciente({ nombre_completo: 'José Luis' });
      await paciente({ nombre_completo: 'José Baja', activo: false });

      for (const filtros of [
        '',
        'q=jose',
        'q=jose&activo=todos',
        `id_obra_social=${os}`,
        'activo=false',
      ]) {
        const conteo = await llamar('get', `/pacientes/conteo?${filtros}`, cookie);
        const lista = await llamar('get', `/pacientes?${filtros}`, cookie);
        expect(conteo.status, filtros).toBe(200);
        expect(conteo.body).toEqual({ total: lista.body.meta.total });
      }
      expect((await llamar('get', '/pacientes/conteo?q=jose', cookie)).body).toEqual({ total: 2 });
      // El conteo no admite orden ni paginación
      expect((await llamar('get', '/pacientes/conteo?page=1', cookie)).status).toBe(400);
      expect((await llamar('get', '/pacientes/conteo?orden=nombre', cookie)).status).toBe(400);
    });

    it('el resumen devuelve los totales y la distribución por obra social', async () => {
      const osde = await obraSocial('OSDE');
      const pami = await obraSocial('PAMI');
      await paciente({ nombre_completo: 'A', dni: '30000001', id_obra_social: osde });
      await paciente({ nombre_completo: 'B' }); // sin DNI ni obra social
      await paciente({ nombre_completo: 'C', activo: false }); // inactivo: no cuenta en sin_dni
      await paciente({
        nombre_completo: 'D',
        dni: '30000004',
        id_obra_social: osde,
        creado_en: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      });
      await paciente({ nombre_completo: 'E', dni: '30000005', id_obra_social: pami });

      const res = await llamar('get', '/pacientes/resumen', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        total: 5,
        activos: 4,
        inactivos: 1,
        nuevos_hoy: 4,
        nuevos_semana: 4,
        nuevos_mes: 4,
        sin_dni: 1,
        sin_obra_social: 1,
        por_obra_social: [
          { id_obra_social: osde, nombre: 'OSDE', cantidad: 2 },
          { id_obra_social: pami, nombre: 'PAMI', cantidad: 1 },
        ],
      });
    });
  });

  describe('ficha', () => {
    it('devuelve la ficha con su resumen y registra ver_paciente', async () => {
      const os = await obraSocial('OSDE');
      const id = await paciente({
        nombre_completo: 'Ana',
        id_obra_social: os,
        observaciones: 'nota',
      });
      await consulta(id, '2024-03-01T12:00:00Z');
      await consulta(id, '2024-05-10T12:00:00Z');
      await consulta(id, '2024-06-10T12:00:00Z', true);
      await archivo(id);
      await archivo(id, true);

      const res = await llamar('get', `/pacientes/paciente/${id}`, cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        nombre_completo: 'Ana',
        observaciones: 'nota',
        obra_social: { id: os, nombre: 'OSDE' },
        resumen: {
          total_consultas: 2,
          ultima_consulta: '2024-05-10T12:00:00.000Z',
          total_archivos: 1,
        },
      });
      const vistas = await auditoriaDe(migrador, 'ver_paciente');
      expect(vistas).toHaveLength(1);
      expect(vistas[0]).toMatchObject({
        id_usuario: idUsuario,
        entidad: 'paciente',
        entidad_id: id,
      });
      expect(vistas[0].detalle).toBeNull();
    });

    it('también se puede ver un paciente dado de baja; 404 e id inválido', async () => {
      const id = await paciente({ nombre_completo: 'Baja', activo: false });
      expect((await llamar('get', `/pacientes/paciente/${id}`, cookie)).body.activo).toBe(false);
      expect((await llamar('get', '/pacientes/paciente/999999', cookie)).status).toBe(404);
      expect((await llamar('get', '/pacientes/paciente/abc', cookie)).status).toBe(400);
      expect(await auditoriaDe(migrador, 'ver_paciente')).toHaveLength(1);
    });
  });

  describe('edición', () => {
    it('guarda el antes y el después de los datos administrativos en la auditoría', async () => {
      const id = await paciente({ nombre_completo: 'Ana', telefono: '111', email: 'a@x.com' });
      const res = await llamar('patch', `/pacientes/paciente/${id}`, cookie, {
        telefono: '222',
        email: null,
        nombre_completo: 'Ana María',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        telefono: '222',
        email: null,
        nombre_completo: 'Ana María',
      });

      const [registro] = await auditoriaDe(migrador, 'paciente_editar');
      expect(registro.entidad_id).toBe(id);
      expect([...registro.detalle.campos].sort()).toEqual(['email', 'nombre_completo', 'telefono']);
      expect(registro.detalle.antes).toEqual({
        telefono: '111',
        email: 'a@x.com',
        nombre_completo: 'Ana',
      });
      expect(registro.detalle.despues).toEqual({
        telefono: '222',
        email: null,
        nombre_completo: 'Ana María',
      });
    });

    it('las observaciones solo dejan constancia del campo, nunca su texto', async () => {
      const id = await paciente({ nombre_completo: 'Ana', observaciones: 'diabetes tipo 2' });
      await llamar('patch', `/pacientes/paciente/${id}`, cookie, {
        observaciones: 'hipertensión',
      }).expect(200);
      const [registro] = await auditoriaDe(migrador, 'paciente_editar');
      expect(registro.detalle.campos).toEqual(['observaciones']);
      expect(JSON.stringify(registro)).not.toContain('diabetes');
      expect(JSON.stringify(registro)).not.toContain('hipertensión');
    });

    it('una edición sin cambios reales no audita ni toca la fecha de actualización', async () => {
      const id = await paciente({ nombre_completo: 'Ana', telefono: '111' });
      const antes = await migrador.query('SELECT actualizado_en FROM paciente WHERE id = $1', [id]);
      const res = await llamar('patch', `/pacientes/paciente/${id}`, cookie, { telefono: '111' });
      expect(res.status).toBe(200);
      expect(await auditoriaDe(migrador, 'paciente_editar')).toHaveLength(0);
      const despues = await migrador.query('SELECT actualizado_en FROM paciente WHERE id = $1', [
        id,
      ]);
      expect(despues.rows[0].actualizado_en).toEqual(antes.rows[0].actualizado_en);
    });

    it('actualiza la fecha de actualización cuando algo cambia', async () => {
      const id = await paciente({ nombre_completo: 'Ana', actualizado_en: '2020-01-01T00:00:00Z' });
      const res = await llamar('patch', `/pacientes/paciente/${id}`, cookie, { telefono: '9' });
      expect(new Date(res.body.actualizado_en).getFullYear()).toBeGreaterThan(2020);
    });

    it('el DNI nuevo no puede pertenecer a otro paciente ni borrarse', async () => {
      await paciente({ nombre_completo: 'Otro', dni: '30000001' });
      const id = await paciente({ nombre_completo: 'Ana', dni: '30000002' });

      const duplicado = await llamar('patch', `/pacientes/paciente/${id}`, cookie, {
        dni: '30.000.001',
      });
      expect(duplicado.status).toBe(409);
      expect(duplicado.body.error.code).toBe('DNI_DUPLICADO');
      expect(
        (await llamar('patch', `/pacientes/paciente/${id}`, cookie, { dni: null })).status,
      ).toBe(400);
      expect(
        (await llamar('patch', `/pacientes/paciente/${id}`, cookie, { dni: '30.000.003' })).body
          .dni,
      ).toBe('30000003');
    });

    it('permite cambiar y quitar la obra social, pero no asignar una dada de baja', async () => {
      const osde = await obraSocial('OSDE');
      const vieja = await obraSocial('Vieja', false);
      const id = await paciente({ nombre_completo: 'Ana' });

      expect(
        (await llamar('patch', `/pacientes/paciente/${id}`, cookie, { id_obra_social: osde })).body
          .obra_social.nombre,
      ).toBe('OSDE');
      const rechazada = await llamar('patch', `/pacientes/paciente/${id}`, cookie, {
        id_obra_social: vieja,
      });
      expect(rechazada.status).toBe(422);
      expect(rechazada.body.error.code).toBe('OBRA_SOCIAL_INACTIVA');
      expect(
        (await llamar('patch', `/pacientes/paciente/${id}`, cookie, { id_obra_social: null })).body
          .obra_social,
      ).toBeNull();
    });

    it('conserva una obra social que se dio de baja mientras no se la cambie', async () => {
      const vieja = await obraSocial('Vieja', false);
      const id = await paciente({ nombre_completo: 'Ana', id_obra_social: vieja });
      const res = await llamar('patch', `/pacientes/paciente/${id}`, cookie, {
        telefono: '1',
        id_obra_social: vieja,
      });
      expect(res.status).toBe(200);
      expect(res.body.obra_social).toMatchObject({ id: vieja, activa: false });
    });

    it('rechaza cuerpos vacíos, campos que no se editan y pacientes inexistentes', async () => {
      const id = await paciente({ nombre_completo: 'Ana' });
      for (const cuerpo of [
        {},
        { activo: false },
        { id: 3 },
        { creado_en: '2020-01-01' },
        { nombre_completo: '' },
      ]) {
        expect(
          (await llamar('patch', `/pacientes/paciente/${id}`, cookie, cuerpo)).status,
          JSON.stringify(cuerpo),
        ).toBe(400);
      }
      expect(
        (await llamar('patch', '/pacientes/paciente/999999', cookie, { telefono: '1' })).status,
      ).toBe(404);
    });

    it('un paciente dado de baja no se edita hasta reactivarlo', async () => {
      const id = await paciente({ nombre_completo: 'Ana', activo: false });
      const res = await llamar('patch', `/pacientes/paciente/${id}`, cookie, { telefono: '1' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PACIENTE_INACTIVO');
    });
  });

  describe('baja lógica y reactivación', () => {
    it('la baja no pierde historial; repetirla no duplica la auditoría; reactivar lo devuelve', async () => {
      const id = await paciente({ nombre_completo: 'Ana' });
      await consulta(id, '2024-03-01T12:00:00Z');
      await archivo(id);

      const baja = await llamar('delete', `/pacientes/paciente/${id}`, cookie);
      expect(baja.status).toBe(200);
      expect(baja.body.activo).toBe(false);
      expect((await llamar('delete', `/pacientes/paciente/${id}`, cookie)).status).toBe(200);
      expect(await auditoriaDe(migrador, 'paciente_baja')).toHaveLength(1);

      // Sigue existiendo, con todo su historial
      expect((await migrador.query('SELECT 1 FROM paciente WHERE id = $1', [id])).rowCount).toBe(1);
      expect(
        (await migrador.query('SELECT 1 FROM consulta WHERE id_paciente = $1', [id])).rowCount,
      ).toBe(1);
      expect(
        (await migrador.query('SELECT 1 FROM paciente_archivo WHERE id_paciente = $1', [id]))
          .rowCount,
      ).toBe(1);
      const ficha = await llamar('get', `/pacientes/paciente/${id}`, cookie);
      expect(ficha.body.resumen).toMatchObject({ total_consultas: 1, total_archivos: 1 });
      expect(nombres(await llamar('get', '/pacientes', cookie))).toEqual([]);

      const reactivado = await llamar('post', `/pacientes/paciente/${id}/reactivar`, cookie);
      expect(reactivado.status).toBe(200);
      expect(reactivado.body.activo).toBe(true);
      await llamar('post', `/pacientes/paciente/${id}/reactivar`, cookie).expect(200);
      expect(await auditoriaDe(migrador, 'paciente_reactivar')).toHaveLength(1);
      expect(nombres(await llamar('get', '/pacientes', cookie))).toEqual(['Ana']);
    });

    it('responde 404 para pacientes inexistentes', async () => {
      expect((await llamar('delete', '/pacientes/paciente/999999', cookie)).status).toBe(404);
      expect((await llamar('post', '/pacientes/paciente/999999/reactivar', cookie)).status).toBe(
        404,
      );
    });
  });
});
