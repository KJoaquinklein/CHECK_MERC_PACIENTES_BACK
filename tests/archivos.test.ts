import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as servicio from '../src/modules/archivos/archivos.service.js';
import { DIRECTORIO_TEMPORAL } from '../src/modules/archivos/subida.js';
import {
  auditoriaDe,
  crearAppDePrueba,
  crearLlamador,
  insertarUsuario,
  iniciarSesionComo,
} from './utilidades/app.js';
import {
  contarArchivosEn,
  EXE,
  GIF,
  HTML_COMO_PNG,
  JPEG,
  PDF,
  PNG,
  subirArchivo,
  temporalesPendientes,
  TEXTO,
} from './utilidades/archivos.js';
import {
  configBasePruebas,
  limpiarDatos,
  limpiarDatosClinicos,
  poolApp,
  poolMigrador,
  type ConfigBasePruebas,
} from './utilidades/db.js';

const config: ConfigBasePruebas | null = configBasePruebas();

describe.skipIf(!config)('archivos de pacientes, driver local (PostgreSQL real)', () => {
  let creada: ReturnType<typeof crearAppDePrueba>;
  let chica: ReturnType<typeof crearAppDePrueba>; // MAX_UPLOAD_MB muy bajo
  let redireccion: ReturnType<typeof crearAppDePrueba>;
  let migrador: pg.Pool;
  let llamar: ReturnType<typeof crearLlamador>;
  let cookie: string;
  let idUsuario: number;

  beforeAll(async () => {
    rmSync(DIRECTORIO_TEMPORAL, { recursive: true, force: true });
    creada = crearAppDePrueba(config!);
    chica = crearAppDePrueba(config!, { MAX_UPLOAD_MB: '0.01' }); // 10.485 bytes
    redireccion = crearAppDePrueba(config!, { DOWNLOAD_MODE: 'redirect' });
    migrador = poolMigrador(config!);
    llamar = crearLlamador(creada.app);
    await limpiarDatos(migrador);
    idUsuario = await insertarUsuario(migrador, { nombre_usuario: 'profe' });
    cookie = await iniciarSesionComo(creada.app, 'profe');
  });
  afterAll(async () => {
    for (const instancia of [creada, chica, redireccion]) {
      await instancia.pool.end();
      rmSync(instancia.directorioStorage, { recursive: true, force: true });
    }
    await migrador.end();
  });
  beforeEach(async () => {
    await limpiarDatosClinicos(migrador);
    for (const instancia of [creada, chica, redireccion]) {
      rmSync(instancia.directorioStorage, { recursive: true, force: true });
    }
  });

  // --- datos de prueba ---
  async function paciente(nombre = 'Ana Pérez', activo = true) {
    const { rows } = await migrador.query<{ id: number }>(
      'INSERT INTO paciente (nombre_completo, activo) VALUES ($1, $2) RETURNING id',
      [nombre, activo],
    );
    return rows[0]!.id;
  }
  async function consulta(idPaciente: number, anulada = false) {
    const { rows } = await migrador.query<{ id: number }>(
      'INSERT INTO consulta (id_paciente, anulada) VALUES ($1, $2) RETURNING id',
      [idPaciente, anulada],
    );
    await migrador.query(
      "INSERT INTO consulta_contenido (id_consulta, version, contenido) VALUES ($1, 0, 'texto')",
      [rows[0]!.id],
    );
    return rows[0]!.id;
  }
  async function subir(
    idPaciente: number,
    adjunto = { contenido: PDF, nombre: 'estudio.pdf', mime: 'application/pdf' },
    campos: Record<string, string | number> = {},
  ) {
    const res = await subirArchivo(
      creada.app,
      cookie,
      { id_paciente: idPaciente, ...campos },
      adjunto,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: number; [campo: string]: unknown };
  }
  const claveDe = async (id: number) =>
    (await migrador.query('SELECT storage_key FROM paciente_archivo WHERE id = $1', [id])).rows[0]
      .storage_key as string;
  const cantidadEnBase = async () =>
    (await migrador.query('SELECT 1 FROM paciente_archivo')).rowCount;
  const ids = (res: { body: { data: { id: number }[] } }) => res.body.data.map((fila) => fila.id);
  const objetosGuardados = () => contarArchivosEn(creada.directorioStorage);

  describe('acceso', () => {
    it('exige sesión en todas las rutas, incluida la subida', async () => {
      for (const [metodo, ruta] of [
        ['get', '/archivos'],
        ['get', '/archivos/1'],
        ['get', '/archivos/1/contenido'],
        ['patch', '/archivos/1'],
        ['delete', '/archivos/1'],
        ['post', '/archivos/1/restaurar'],
      ] as const) {
        expect((await llamar(metodo, ruta)).status, `${metodo} ${ruta}`).toBe(401);
      }
      const sinSesion = await subirArchivo(
        creada.app,
        undefined,
        { id_paciente: 1 },
        { contenido: PDF, nombre: 'a.pdf' },
      );
      expect(sinSesion.status).toBe(401);
      expect(temporalesPendientes()).toBe(0);
    });
  });

  describe('subida', () => {
    it('guarda el PDF con clave aleatoria, sha256 correcto y auditoría sin el nombre del archivo', async () => {
      const idPaciente = await paciente();
      const res = await subirArchivo(
        creada.app,
        cookie,
        {
          id_paciente: idPaciente,
          descripcion: '  Resonancia de rodilla ',
          fecha_documento: '2024-05-10',
        },
        { contenido: PDF, nombre: 'Resonancia ñandú.pdf', mime: 'application/pdf' },
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id_paciente: idPaciente,
        id_consulta: null,
        tipo: 'estudio',
        descripcion: 'Resonancia de rodilla',
        fecha_documento: '2024-05-10',
        nombre_original: 'Resonancia ñandú.pdf',
        mime_type: 'application/pdf',
        tamano_bytes: PDF.length,
        sha256: createHash('sha256').update(PDF).digest('hex'),
        eliminado: false,
        eliminado_en: null,
        subido_por: { id: idUsuario, nombre_completo: 'Usuario profe' },
      });
      // La clave interna del almacenamiento no sale de la aplicación
      expect(res.body).not.toHaveProperty('storage_key');
      expect(res.body).not.toHaveProperty('origen_uuid');

      const clave = await claveDe(res.body.id);
      expect(clave).toMatch(new RegExp(`^estudios/${idPaciente}/[0-9a-f-]{36}\\.pdf$`));
      expect(clave).not.toContain('Resonancia');
      expect(await creada.storage.exists(clave)).toBe(true);

      const [registro] = await auditoriaDe(migrador, 'archivo_subir');
      expect(registro).toMatchObject({
        id_usuario: idUsuario,
        entidad: 'archivo',
        entidad_id: res.body.id,
      });
      expect(registro.detalle).toEqual({
        id_paciente: idPaciente,
        tipo: 'estudio',
        mime_type: 'application/pdf',
        tamano_bytes: PDF.length,
      });
      expect(JSON.stringify(registro)).not.toMatch(/Resonancia|rodilla/);
      expect(temporalesPendientes()).toBe(0);
    });

    it('las fichas antiguas (imágenes) van al prefijo fichas-antiguas', async () => {
      const idPaciente = await paciente();
      const ficha = await subir(
        idPaciente,
        { contenido: PNG, nombre: 'ficha 1998.png', mime: 'image/png' },
        { tipo: 'ficha_antigua' },
      );
      expect(ficha).toMatchObject({ tipo: 'ficha_antigua', mime_type: 'image/png' });
      expect(await claveDe(ficha.id)).toMatch(
        new RegExp(`^fichas-antiguas/${idPaciente}/[0-9a-f-]{36}\\.png$`),
      );

      const foto = await subir(idPaciente, {
        contenido: JPEG,
        nombre: 'radiografia.jpeg',
        mime: 'image/jpeg',
      });
      expect(foto).toMatchObject({ tipo: 'estudio', mime_type: 'image/jpeg' });
      expect(await claveDe(foto.id)).toMatch(/\.jpg$/);
    });

    it('el tipo sale del contenido real, no de la extensión ni del Content-Type del cliente', async () => {
      const idPaciente = await paciente();
      const res = await subir(idPaciente, {
        contenido: PNG,
        nombre: 'foto.pdf',
        mime: 'application/pdf',
      });
      expect(res.mime_type).toBe('image/png');
      expect(await claveDe(res.id)).toMatch(/\.png$/);
    });

    it('rechaza lo que no es PDF/PNG/JPEG aunque se llame .pdf (415) y no deja rastros', async () => {
      const idPaciente = await paciente();
      const intentos = [
        { contenido: EXE, nombre: 'factura.pdf', mime: 'application/pdf' },
        { contenido: EXE, nombre: 'programa.exe', mime: 'application/octet-stream' },
        { contenido: TEXTO, nombre: 'notas.pdf', mime: 'application/pdf' },
        { contenido: GIF, nombre: 'animacion.png', mime: 'image/png' },
        { contenido: HTML_COMO_PNG, nombre: 'pagina.png', mime: 'image/png' },
      ];
      for (const adjunto of intentos) {
        const res = await subirArchivo(creada.app, cookie, { id_paciente: idPaciente }, adjunto);
        expect(res.status, adjunto.nombre).toBe(415);
        expect(res.body.error.code).toBe('TIPO_NO_PERMITIDO');
      }
      expect(await cantidadEnBase()).toBe(0);
      expect(objetosGuardados()).toBe(0);
      expect(temporalesPendientes()).toBe(0);
    });

    it('rechaza pedidos mal formados (400): sin archivo, campo equivocado, vacío, repetido o con campos extra', async () => {
      const idPaciente = await paciente();
      const ok = { contenido: PDF, nombre: 'a.pdf' };
      const futuro = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
      const multipart = () =>
        request(creada.app)
          .post('/archivos')
          .set('X-Requested-With', 'pruebas')
          .set('Cookie', cookie);
      const subirCon = (
        campos: Record<string, string | number>,
        adjunto: Parameters<typeof subirArchivo>[3],
        campo?: string,
      ) => subirArchivo(creada.app, cookie, campos, adjunto, campo);
      const casos: [
        string,
        () => PromiseLike<{ status: number; body: { error: { code: string } } }>,
      ][] = [
        ['sin archivo', () => subirCon({ id_paciente: idPaciente }, null)],
        ['campo mal nombrado', () => subirCon({ id_paciente: idPaciente }, ok, 'documento')],
        [
          'archivo vacío',
          () =>
            subirCon({ id_paciente: idPaciente }, { contenido: Buffer.alloc(0), nombre: 'a.pdf' }),
        ],
        ['sin id_paciente', () => subirCon({}, ok)],
        ['id_paciente inválido', () => subirCon({ id_paciente: 'x' }, ok)],
        ['tipo inválido', () => subirCon({ id_paciente: idPaciente, tipo: 'radiografia' }, ok)],
        [
          'fecha inválida',
          () => subirCon({ id_paciente: idPaciente, fecha_documento: '10/05/2024' }, ok),
        ],
        ['fecha futura', () => subirCon({ id_paciente: idPaciente, fecha_documento: futuro }, ok)],
        ['campo desconocido', () => subirCon({ id_paciente: idPaciente, mime_type: 'x' }, ok)],
        ['campo que no se carga', () => subirCon({ id_paciente: idPaciente, sha256: 'a' }, ok)],
        [
          'dos archivos',
          () =>
            multipart()
              .field('id_paciente', String(idPaciente))
              .attach('file', PDF, 'a.pdf')
              .attach('file', PDF, 'b.pdf'),
        ],
        ['no es multipart', () => multipart().send({ id_paciente: idPaciente })],
      ];
      for (const [nombre, peticion] of casos) {
        const res = await peticion();
        expect(res.status, nombre).toBe(400);
        expect(res.body.error.code, nombre).toBe('VALIDACION');
      }
      expect(await cantidadEnBase()).toBe(0);
      expect(objetosGuardados()).toBe(0);
      expect(temporalesPendientes()).toBe(0);
    });

    it('aplica las reglas de negocio: paciente activo, ficha solo imagen, consulta del mismo paciente', async () => {
      const ana = await paciente('Ana');
      const beto = await paciente('Beto');
      const baja = await paciente('Baja', false);
      const consultaDeBeto = await consulta(beto);
      const consultaAnulada = await consulta(ana, true);
      const consultaDeAna = await consulta(ana);
      const adjunto = { contenido: PDF, nombre: 'a.pdf' };
      const probar = async (
        campos: Record<string, string | number>,
        estado: number,
        codigo: string,
      ) => {
        const res = await subirArchivo(creada.app, cookie, campos, adjunto);
        expect(res.status, JSON.stringify(campos)).toBe(estado);
        expect(res.body.error.code).toBe(codigo);
      };

      await probar({ id_paciente: 999999 }, 422, 'PACIENTE_INVALIDO');
      await probar({ id_paciente: baja }, 409, 'PACIENTE_INACTIVO');
      await probar({ id_paciente: ana, tipo: 'ficha_antigua' }, 422, 'TIPO_INCOMPATIBLE');
      await probar({ id_paciente: ana, id_consulta: consultaDeBeto }, 422, 'CONSULTA_INVALIDA');
      await probar({ id_paciente: ana, id_consulta: 999999 }, 422, 'CONSULTA_INVALIDA');
      await probar({ id_paciente: ana, id_consulta: consultaAnulada }, 422, 'CONSULTA_ANULADA');
      expect(objetosGuardados()).toBe(0);
      expect(temporalesPendientes()).toBe(0);

      const vinculado = await subir(ana, adjunto as never, { id_consulta: consultaDeAna });
      expect(vinculado.id_consulta).toBe(consultaDeAna);
    });

    it('corta la subida que supera MAX_UPLOAD_MB (413) y no deja rastros', async () => {
      const idPaciente = await paciente();
      const grande = Buffer.concat([PDF, Buffer.alloc(30_000, 0x20)]);
      const res = await subirArchivo(
        chica.app,
        cookie,
        { id_paciente: idPaciente },
        { contenido: grande, nombre: 'grande.pdf' },
      );
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('ARCHIVO_DEMASIADO_GRANDE');
      expect(res.body.error.message).toContain('0.01 MB');
      expect(await cantidadEnBase()).toBe(0);
      expect(contarArchivosEn(chica.directorioStorage)).toBe(0);
      expect(temporalesPendientes()).toBe(0);

      // Justo por debajo del límite sí entra
      const aceptable = Buffer.concat([PDF, Buffer.alloc(10_000, 0x20)]);
      const ok = await subirArchivo(
        chica.app,
        cookie,
        { id_paciente: idPaciente },
        { contenido: aceptable, nombre: 'justo.pdf' },
      );
      expect(ok.status).toBe(201);
      expect(ok.body.tamano_bytes).toBe(aceptable.length);
    });

    it('corta una subida de varios MB apenas supera el límite, sin dejar rastros', async () => {
      const idPaciente = await paciente();
      const enorme = Buffer.concat([PDF, Buffer.alloc(8 * 1024 * 1024, 0x20)]);
      // El servidor responde 413 y cierra la conexión; según el momento, el cliente puede ver
      // el 413 o que le cortaron la transferencia: ambas cosas significan que se cortó
      const resultado = await subirArchivo(
        chica.app,
        cookie,
        { id_paciente: idPaciente },
        { contenido: enorme, nombre: 'enorme.pdf' },
      ).then(
        (res) => res.status,
        (error: { code?: string }) => error.code,
      );
      expect([413, 'ECONNRESET', 'EPIPE']).toContain(resultado);
      await new Promise((resolver) => setTimeout(resolver, 300));
      expect(await cantidadEnBase()).toBe(0);
      expect(contarArchivosEn(chica.directorioStorage)).toBe(0);
      expect(temporalesPendientes()).toBe(0);
    });

    it('si falla el INSERT, borra el objeto que ya había subido (sin huérfanos)', async () => {
      const idPaciente = await paciente();
      const rutaTemporal = path.join(os.tmpdir(), `prueba-${Math.random()}.pdf`);
      writeFileSync(rutaTemporal, PDF);

      // Un pool cuya inserción de archivos falla, para simular la caída entre "guardar" y "registrar"
      // Pool propio, descartable: así el truco no contamina las conexiones de los demás tests
      const real = poolApp(config!);
      const conFallo = new Proxy(real, {
        get(destino, propiedad) {
          if (propiedad === 'connect') {
            return async () => {
              const cliente = await destino.connect();
              const original = cliente.query.bind(cliente) as (...args: unknown[]) => unknown;
              (cliente as unknown as { query: unknown }).query = (...args: unknown[]) =>
                typeof args[0] === 'string' && args[0].includes('INSERT INTO paciente_archivo')
                  ? Promise.reject(new Error('falla simulada de la base'))
                  : original(...args);
              return cliente;
            };
          }
          const valor = Reflect.get(destino, propiedad) as unknown;
          return typeof valor === 'function' ? valor.bind(destino) : valor;
        },
      }) as pg.Pool;

      const log = { error: vi.fn() };
      await expect(
        servicio.subir(
          { pool: conFallo, storage: creada.storage, log },
          { id: idUsuario, ip: null },
          { id_paciente: idPaciente, tipo: 'estudio' },
          {
            rutaTemporal,
            nombreOriginal: 'a.pdf',
            bytes: PDF.length,
            sha256: 'a'.repeat(64),
            mime: 'application/pdf',
            extension: 'pdf',
          },
        ),
      ).rejects.toThrow('falla simulada de la base');
      expect(objetosGuardados()).toBe(0);
      expect(await cantidadEnBase()).toBe(0);
      expect(log.error).not.toHaveBeenCalled();
      await real.end();
      rmSync(rutaTemporal, { force: true });
    });
  });

  describe('listado', () => {
    async function insertar(
      idPaciente: number,
      datos: {
        tipo?: string;
        mime?: string;
        fecha?: string | null;
        subido?: string;
        eliminado?: boolean;
      },
    ) {
      const { rows } = await migrador.query<{ id: number }>(
        `INSERT INTO paciente_archivo (id_paciente, tipo, nombre_original, mime_type, tamano_bytes, sha256,
                                       storage_key, fecha_documento, subido_en, eliminado)
         VALUES ($1, $2, 'x', $3, 10, $4, $5, $6, $7, $8) RETURNING id`,
        [
          idPaciente,
          datos.tipo ?? 'estudio',
          datos.mime ?? 'application/pdf',
          'a'.repeat(64),
          `estudios/${idPaciente}/${Math.random()}`,
          datos.fecha ?? null,
          datos.subido ?? '2024-06-01T12:00:00Z',
          datos.eliminado ?? false,
        ],
      );
      return rows[0]!.id;
    }

    it('filtra por paciente, tipo, formato, fecha del documento y eliminados', async () => {
      const ana = await paciente('Ana');
      const beto = await paciente('Beto');
      const a1 = await insertar(ana, { fecha: '2024-01-10', subido: '2024-06-01T12:00:00Z' });
      const a2 = await insertar(ana, {
        tipo: 'ficha_antigua',
        mime: 'image/png',
        fecha: '1999-05-05',
        subido: '2024-06-02T12:00:00Z',
      });
      const b1 = await insertar(beto, {
        mime: 'image/jpeg',
        fecha: '2024-03-20',
        subido: '2024-06-03T12:00:00Z',
      });
      const a3 = await insertar(ana, {
        fecha: '2024-02-02',
        subido: '2024-06-04T12:00:00Z',
        eliminado: true,
      });

      const listar = async (consulta: string) =>
        ids(await llamar('get', `/archivos?${consulta}`, cookie));
      expect(await listar('')).toEqual([b1, a2, a1]); // más recientes primero, sin eliminados
      expect(await listar(`id_paciente=${ana}`)).toEqual([a2, a1]);
      expect(await listar('tipo=ficha_antigua')).toEqual([a2]);
      expect(await listar('mime_type=image/jpeg')).toEqual([b1]);
      expect(await listar('desde=2024-02-01&hasta=2024-03-31')).toEqual([b1]);
      expect(await listar('desde=2024-02-01')).toEqual([b1]);
      expect(await listar('hasta=2000-01-01')).toEqual([a2]);
      expect(await listar(`id_paciente=${ana}&incluir_eliminados=true`)).toEqual([a3, a2, a1]);
      expect(await listar('orden=fecha_documento&dir=asc')).toEqual([a2, a1, b1]);

      const res = await llamar('get', '/archivos?page_size=2&page=2', cookie);
      expect(res.body.meta).toEqual({ page: 2, page_size: 2, total: 3 });
      expect(ids(res)).toEqual([a1]);
      expect(res.body.data[0]).not.toHaveProperty('storage_key');
      expect(res.body.data[0].subido_por).toBeNull();
    });

    it('rechaza parámetros fuera de la lista blanca', async () => {
      for (const consulta of [
        'orden=storage_key',
        'orden=subido_en;DROP TABLE paciente_archivo',
        'dir=desc;DELETE FROM paciente_archivo',
        'tipo=otro',
        'mime_type=application/x-msdownload',
        'incluir_eliminados=1',
        'desde=ayer',
        'desde=2024-05-02&hasta=2024-05-01',
        'id_paciente=1;--',
        'page_size=101',
        'desconocido=1',
      ]) {
        const res = await llamar(
          'get',
          `/archivos?${encodeURIComponent(consulta).replace(/%3D/g, '=')}`,
          cookie,
        );
        expect(res.status, consulta).toBe(400);
      }
    });
  });

  describe('metadatos', () => {
    it('devuelve los metadatos (también de un eliminado) y registra ver_archivo', async () => {
      const subido = await subir(await paciente());
      await llamar('delete', `/archivos/${subido.id}`, cookie).expect(200);

      const res = await llamar('get', `/archivos/${subido.id}`, cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: subido.id, eliminado: true });
      expect(res.body).not.toHaveProperty('storage_key');
      const [registro] = await auditoriaDe(migrador, 'ver_archivo');
      expect(registro).toMatchObject({
        id_usuario: idUsuario,
        entidad: 'archivo',
        entidad_id: subido.id,
      });
      expect(registro.detalle).toEqual({ vista: 'metadatos' });
    });

    it('404 para inexistente, 400 para id inválido, sin auditar', async () => {
      expect((await llamar('get', '/archivos/999999', cookie)).status).toBe(404);
      expect((await llamar('get', '/archivos/abc', cookie)).status).toBe(400);
      expect(await auditoriaDe(migrador, 'ver_archivo')).toHaveLength(0);
    });
  });

  describe('descarga', () => {
    it('entrega el archivo idéntico con encabezados seguros y registra ver_archivo', async () => {
      const subido = await subir(await paciente(), {
        contenido: PDF,
        nombre: 'Resonancia ñandú.pdf',
        mime: 'application/pdf',
      });

      const res = await request(creada.app)
        .get(`/archivos/${subido.id}/contenido`)
        .set('Cookie', cookie)
        .responseType('blob');
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body as Buffer).equals(PDF)).toBe(true);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-length']).toBe(String(PDF.length));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['content-disposition']).toBe(
        `inline; filename="Resonancia _and_.pdf"; filename*=UTF-8''Resonancia%20%C3%B1and%C3%BA.pdf`,
      );
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(res.headers['cross-origin-resource-policy']).toBe('same-site');

      const lecturas = await auditoriaDe(migrador, 'ver_archivo');
      expect(lecturas).toHaveLength(1);
      expect(lecturas[0]).toMatchObject({
        id_usuario: idUsuario,
        entidad: 'archivo',
        entidad_id: subido.id,
      });
      expect(lecturas[0].detalle).toEqual({ vista: 'contenido' });
    });

    it('el Content-Type sale de la base: una imagen subida como .pdf se sirve como image/png', async () => {
      const subido = await subir(await paciente(), {
        contenido: PNG,
        nombre: 'foto.pdf',
        mime: 'application/pdf',
      });
      const res = await request(creada.app)
        .get(`/archivos/${subido.id}/contenido`)
        .set('Cookie', cookie)
        .responseType('blob');
      expect(res.headers['content-type']).toBe('image/png');
      expect(Buffer.from(res.body as Buffer).equals(PNG)).toBe(true);
    });

    it('exige sesión y no audita los intentos sin sesión', async () => {
      const subido = await subir(await paciente());
      const res = await request(creada.app).get(`/archivos/${subido.id}/contenido`);
      expect(res.status).toBe(401);
      expect(await auditoriaDe(migrador, 'ver_archivo')).toHaveLength(0);
    });

    it('un archivo eliminado no se descarga; uno cuyo objeto falta responde 404 sin romper', async () => {
      const subido = await subir(await paciente());
      await llamar('delete', `/archivos/${subido.id}`, cookie).expect(200);
      const eliminado = await llamar('get', `/archivos/${subido.id}/contenido`, cookie);
      expect(eliminado.status).toBe(404);
      expect(eliminado.body.error.code).toBe('ARCHIVO_ELIMINADO');

      await llamar('post', `/archivos/${subido.id}/restaurar`, cookie).expect(200);
      await creada.storage.delete(await claveDe(subido.id));
      const sinObjeto = await llamar('get', `/archivos/${subido.id}/contenido`, cookie);
      expect(sinObjeto.status).toBe(404);
      expect(sinObjeto.body.error.code).toBe('ARCHIVO_NO_DISPONIBLE');
      expect(await auditoriaDe(migrador, 'ver_archivo')).toHaveLength(0);
    });

    it('también se descargan los archivos de un paciente dado de baja', async () => {
      const idPaciente = await paciente();
      const subido = await subir(idPaciente);
      await migrador.query('UPDATE paciente SET activo = false WHERE id = $1', [idPaciente]);
      expect((await llamar('get', `/archivos/${subido.id}/contenido`, cookie)).status).toBe(200);
    });

    it('404 para inexistente y 400 para id inválido', async () => {
      expect((await llamar('get', '/archivos/999999/contenido', cookie)).status).toBe(404);
      expect((await llamar('get', '/archivos/abc/contenido', cookie)).status).toBe(400);
    });

    it('con DOWNLOAD_MODE=redirect y driver local (que no firma URLs) transmite igual', async () => {
      const idPaciente = await paciente();
      const subido = await subirArchivo(
        redireccion.app,
        cookie,
        { id_paciente: idPaciente },
        { contenido: PDF, nombre: 'a.pdf' },
      );
      expect(subido.status).toBe(201);
      const res = await request(redireccion.app)
        .get(`/archivos/${subido.body.id}/contenido`)
        .set('Cookie', cookie)
        .responseType('blob');
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body as Buffer).equals(PDF)).toBe(true);
    });
  });

  describe('edición de metadatos', () => {
    it('cambia descripción, tipo, fecha y consulta; audita sin el texto de la descripción', async () => {
      const idPaciente = await paciente();
      const idConsulta = await consulta(idPaciente);
      const subido = await subir(
        idPaciente,
        { contenido: PNG, nombre: 'a.png', mime: 'image/png' },
        { descripcion: 'dato clínico original' },
      );

      const res = await llamar('patch', `/archivos/${subido.id}`, cookie, {
        descripcion: 'dato clínico nuevo',
        tipo: 'ficha_antigua',
        fecha_documento: '1999-05-05',
        id_consulta: idConsulta,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        descripcion: 'dato clínico nuevo',
        tipo: 'ficha_antigua',
        fecha_documento: '1999-05-05',
        id_consulta: idConsulta,
      });
      expect(res.body.sha256).toBe(subido.sha256);

      const [registro] = await auditoriaDe(migrador, 'archivo_editar');
      expect(registro.entidad_id).toBe(subido.id);
      expect([...registro.detalle.campos].sort()).toEqual([
        'descripcion',
        'fecha_documento',
        'id_consulta',
        'tipo',
      ]);
      expect(registro.detalle.antes).toEqual({
        tipo: 'estudio',
        fecha_documento: null,
        id_consulta: null,
      });
      expect(registro.detalle.despues).toEqual({
        tipo: 'ficha_antigua',
        fecha_documento: '1999-05-05',
        id_consulta: idConsulta,
      });
      expect(JSON.stringify(registro)).not.toContain('clínico');

      const limpio = await llamar('patch', `/archivos/${subido.id}`, cookie, {
        id_consulta: null,
        descripcion: '',
        fecha_documento: null,
      });
      expect(limpio.body).toMatchObject({
        id_consulta: null,
        descripcion: null,
        fecha_documento: null,
      });
    });

    it('no permite tocar el binario ni sus datos derivados', async () => {
      const subido = await subir(await paciente());
      for (const cuerpo of [
        {},
        { mime_type: 'image/png' },
        { sha256: 'a'.repeat(64) },
        { tamano_bytes: 1 },
        { nombre_original: 'otro.pdf' },
        { eliminado: true },
        { id_paciente: 2 },
        { storage_key: 'x' },
      ]) {
        expect(
          (await llamar('patch', `/archivos/${subido.id}`, cookie, cuerpo)).status,
          JSON.stringify(cuerpo),
        ).toBe(400);
      }
    });

    it('aplica las reglas: ficha solo imagen, consulta del mismo paciente, sin cambios no audita', async () => {
      const ana = await paciente('Ana');
      const beto = await paciente('Beto');
      const delOtro = await consulta(beto);
      const pdf = await subir(
        ana,
        { contenido: PDF, nombre: 'a.pdf', mime: 'application/pdf' },
        { descripcion: 'igual' },
      );

      const incompatible = await llamar('patch', `/archivos/${pdf.id}`, cookie, {
        tipo: 'ficha_antigua',
      });
      expect(incompatible.status).toBe(422);
      expect(incompatible.body.error.code).toBe('TIPO_INCOMPATIBLE');
      const ajena = await llamar('patch', `/archivos/${pdf.id}`, cookie, { id_consulta: delOtro });
      expect(ajena.status).toBe(422);
      expect(ajena.body.error.code).toBe('CONSULTA_INVALIDA');

      await llamar('patch', `/archivos/${pdf.id}`, cookie, {
        descripcion: 'igual',
        tipo: 'estudio',
      }).expect(200);
      expect(await auditoriaDe(migrador, 'archivo_editar')).toHaveLength(0);
      expect((await llamar('patch', '/archivos/999999', cookie, { descripcion: 'x' })).status).toBe(
        404,
      );
    });

    it('no se edita un archivo eliminado ni el de un paciente dado de baja', async () => {
      const idPaciente = await paciente();
      const subido = await subir(idPaciente);
      await llamar('delete', `/archivos/${subido.id}`, cookie).expect(200);
      const eliminado = await llamar('patch', `/archivos/${subido.id}`, cookie, {
        descripcion: 'x',
      });
      expect(eliminado.status).toBe(409);
      expect(eliminado.body.error.code).toBe('ARCHIVO_ELIMINADO');

      await llamar('post', `/archivos/${subido.id}/restaurar`, cookie).expect(200);
      await migrador.query('UPDATE paciente SET activo = false WHERE id = $1', [idPaciente]);
      const inactivo = await llamar('patch', `/archivos/${subido.id}`, cookie, {
        descripcion: 'x',
      });
      expect(inactivo.status).toBe(409);
      expect(inactivo.body.error.code).toBe('PACIENTE_INACTIVO');
    });
  });

  describe('baja lógica y restauración', () => {
    it('la baja conserva el objeto en el almacenamiento; repetir operaciones no duplica la auditoría', async () => {
      const subido = await subir(await paciente());
      const clave = await claveDe(subido.id);

      const baja = await llamar('delete', `/archivos/${subido.id}`, cookie);
      expect(baja.status).toBe(200);
      expect(baja.body).toMatchObject({ eliminado: true, eliminado_en: expect.any(String) });
      await llamar('delete', `/archivos/${subido.id}`, cookie).expect(200);
      expect(await auditoriaDe(migrador, 'archivo_baja')).toHaveLength(1);
      expect(await creada.storage.exists(clave)).toBe(true); // el objeto no se borra
      expect(ids(await llamar('get', '/archivos', cookie))).toEqual([]);
      expect(ids(await llamar('get', '/archivos?incluir_eliminados=true', cookie))).toEqual([
        subido.id,
      ]);

      const restaurado = await llamar('post', `/archivos/${subido.id}/restaurar`, cookie);
      expect(restaurado.status).toBe(200);
      expect(restaurado.body).toMatchObject({ eliminado: false, eliminado_en: null });
      await llamar('post', `/archivos/${subido.id}/restaurar`, cookie).expect(200);
      expect(await auditoriaDe(migrador, 'archivo_restaurar')).toHaveLength(1);
      expect(ids(await llamar('get', '/archivos', cookie))).toEqual([subido.id]);
      expect((await llamar('get', `/archivos/${subido.id}/contenido`, cookie)).status).toBe(200);
    });

    it('cuenta en la ficha del paciente solo mientras no esté eliminado', async () => {
      const idPaciente = await paciente();
      const subido = await subir(idPaciente);
      const total = async () =>
        (await llamar('get', `/pacientes/paciente/${idPaciente}`, cookie)).body.resumen
          .total_archivos;
      expect(await total()).toBe(1);
      await llamar('delete', `/archivos/${subido.id}`, cookie).expect(200);
      expect(await total()).toBe(0);
    });

    it('404 para inexistentes y 409 si el paciente está dado de baja', async () => {
      expect((await llamar('delete', '/archivos/999999', cookie)).status).toBe(404);
      expect((await llamar('post', '/archivos/999999/restaurar', cookie)).status).toBe(404);

      const idPaciente = await paciente();
      const subido = await subir(idPaciente);
      await migrador.query('UPDATE paciente SET activo = false WHERE id = $1', [idPaciente]);
      const res = await llamar('delete', `/archivos/${subido.id}`, cookie);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PACIENTE_INACTIVO');
    });
  });
});
