import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAVE_VALIDA,
  crearAppDePrueba,
  ENCABEZADO_AJAX,
  insertarUsuario,
  iniciarSesionComo,
} from './utilidades/app.js';
import {
  configBasePruebas,
  limpiarDatos,
  poolMigrador,
  type ConfigBasePruebas,
} from './utilidades/db.js';

const config: ConfigBasePruebas | null = configBasePruebas();

describe.skipIf(!config)('usuarios y permisos (PostgreSQL real)', () => {
  let app: ReturnType<typeof crearAppDePrueba>['app'];
  let poolDeLaApp: pg.Pool;
  let migrador: pg.Pool;

  beforeAll(() => {
    const creada = crearAppDePrueba(config!);
    app = creada.app;
    poolDeLaApp = creada.pool;
    migrador = poolMigrador(config!);
  });
  afterAll(async () => {
    await poolDeLaApp.end();
    await migrador.end();
  });
  beforeEach(async () => {
    await limpiarDatos(migrador);
  });

  type Metodo = 'get' | 'post' | 'patch' | 'delete';
  const llamar = (metodo: Metodo, ruta: string, cookie?: string, cuerpo?: object) => {
    const peticion = request(app)[metodo](ruta).set(ENCABEZADO_AJAX);
    if (cookie) peticion.set('Cookie', cookie);
    return cuerpo ? peticion.send(cuerpo) : peticion;
  };

  async function auditoria(accion: string) {
    const { rows } = await migrador.query(
      'SELECT id_usuario, entidad_id, detalle FROM auditoria WHERE accion = $1 ORDER BY id',
      [accion],
    );
    return rows;
  }

  const nuevoUsuario = {
    nombre_usuario: 'secretaria',
    nombre_completo: 'Ana Secretaria',
    rol: 'profesional',
    password_temporal: 'temporal-larga-1234',
  };

  describe('matriz de permisos', () => {
    const rutas: [Metodo, string][] = [
      ['get', '/usuarios'],
      ['post', '/usuarios'],
      ['get', '/usuarios/1'],
      ['patch', '/usuarios/1'],
      ['delete', '/usuarios/1'],
      ['post', '/usuarios/1/reset-password'],
      ['get', '/auditoria'],
      ['get', '/auditoria/1'],
    ];

    it('sin sesión: 401 en todas las rutas protegidas', async () => {
      for (const [metodo, ruta] of rutas) {
        const res = await llamar(metodo, ruta);
        expect(res.status, `${metodo} ${ruta}`).toBe(401);
      }
      for (const ruta of ['/auth/me']) expect((await llamar('get', ruta)).status).toBe(401);
      expect((await llamar('post', '/auth/logout')).status).toBe(401);
      expect((await llamar('post', '/auth/cambiar-password', undefined, {})).status).toBe(401);
    });

    it('un profesional recibe 403 en /usuarios y /auditoria', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'profe', rol: 'profesional' });
      const cookie = await iniciarSesionComo(app, 'profe');
      for (const [metodo, ruta] of rutas) {
        const res = await llamar(metodo, ruta, cookie, metodo === 'get' ? undefined : {});
        expect(res.status, `${metodo} ${ruta}`).toBe(403);
        expect(res.body.error.code).toBe('PROHIBIDO');
      }
    });

    it('un administrador pasa el control de rol', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');
      expect((await llamar('get', '/usuarios', cookie)).status).toBe(200);
      expect((await llamar('get', '/auditoria', cookie)).status).not.toBe(403);
    });
  });

  describe('alta y consulta', () => {
    it('crea un usuario con cambio de contraseña obligatorio y lo audita', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');

      const res = await llamar('post', '/usuarios', cookie, nuevoUsuario);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        nombre_usuario: 'secretaria',
        rol: 'profesional',
        activo: true,
        debe_cambiar_password: true,
      });
      expect(res.body).not.toHaveProperty('password_hash');

      const creados = await auditoria('usuario_crear');
      expect(creados).toHaveLength(1);
      expect(creados[0].entidad_id).toBe(res.body.id);
      expect(JSON.stringify(creados)).not.toContain('temporal-larga');

      // El usuario nuevo entra, pero solo puede cambiar su contraseña
      const sesion = await iniciarSesionComo(app, 'secretaria', 'temporal-larga-1234');
      expect((await llamar('get', '/auth/me', sesion)).body.error.code).toBe(
        'DEBE_CAMBIAR_PASSWORD',
      );
    });

    it('rechaza duplicados (sin distinguir mayúsculas), datos inválidos y campos extra', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');
      await llamar('post', '/usuarios', cookie, nuevoUsuario).expect(201);

      const duplicado = await llamar('post', '/usuarios', cookie, {
        ...nuevoUsuario,
        nombre_usuario: 'SECRETARIA',
      });
      expect(duplicado.status).toBe(409);
      expect(duplicado.body.error.code).toBe('USUARIO_DUPLICADO');

      for (const invalido of [
        { ...nuevoUsuario, password_temporal: 'corta' },
        { ...nuevoUsuario, nombre_usuario: 'a b' },
        { ...nuevoUsuario, rol: 'superadmin' },
        { ...nuevoUsuario, nombre_usuario: 'otra', activo: false },
      ]) {
        const res = await llamar('post', '/usuarios', cookie, invalido);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDACION');
      }
    });

    it('lista con filtros, orden y paginación, y nunca devuelve hashes', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      await insertarUsuario(migrador, { nombre_usuario: 'profe1' });
      await insertarUsuario(migrador, { nombre_usuario: 'profe2', activo: false });
      await insertarUsuario(migrador, { nombre_usuario: 'a_b' });
      await insertarUsuario(migrador, { nombre_usuario: 'axb' });
      const cookie = await iniciarSesionComo(app, 'jefa');

      const todos = await llamar(
        'get',
        '/usuarios?page_size=2&page=2&orden=nombre_usuario',
        cookie,
      );
      expect(todos.status).toBe(200);
      expect(todos.body.meta).toEqual({ page: 2, page_size: 2, total: 5 });
      expect(todos.body.data.map((u: { nombre_usuario: string }) => u.nombre_usuario)).toEqual([
        'jefa',
        'profe1',
      ]);
      expect(JSON.stringify(todos.body)).not.toContain('password_hash');

      const inactivos = await llamar('get', '/usuarios?activo=false', cookie);
      expect(inactivos.body.data.map((u: { nombre_usuario: string }) => u.nombre_usuario)).toEqual([
        'profe2',
      ]);
      const admins = await llamar('get', '/usuarios?rol=admin', cookie);
      expect(admins.body.meta.total).toBe(1);

      // _ y % del texto buscado son literales, no comodines
      const guionBajo = await llamar('get', '/usuarios?q=a_b', cookie);
      expect(guionBajo.body.data.map((u: { nombre_usuario: string }) => u.nombre_usuario)).toEqual([
        'a_b',
      ]);
      expect((await llamar('get', '/usuarios?q=%25', cookie)).body.meta.total).toBe(0);
    });

    it('rechaza orden, dirección y parámetros fuera de la lista blanca (inyección SQL)', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');
      for (const consulta of [
        'orden=nombre_usuario;DROP TABLE usuario',
        'orden=password_hash',
        'dir=asc;DELETE FROM usuario',
        'dir=desc,id',
        'page_size=101',
        'page=0',
        'desconocido=1',
      ]) {
        const res = await llamar(
          'get',
          `/usuarios?${encodeURIComponent(consulta).replace(/%3D/g, '=')}`,
          cookie,
        );
        expect(res.status, consulta).toBe(400);
      }
      // q con intento de inyección es solo texto
      const q = await llamar('get', `/usuarios?q=${encodeURIComponent("' OR 1=1 --")}`, cookie);
      expect(q.status).toBe(200);
      expect(q.body.meta.total).toBe(0);
      expect((await migrador.query('SELECT 1 FROM usuario')).rowCount).toBe(1);
    });

    it('GET /usuarios/:id: existente, inexistente e id inválido', async () => {
      const id = await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');
      expect((await llamar('get', `/usuarios/${id}`, cookie)).body.nombre_usuario).toBe('jefa');
      expect((await llamar('get', '/usuarios/999999', cookie)).status).toBe(404);
      expect((await llamar('get', '/usuarios/abc', cookie)).status).toBe(400);
      expect((await llamar('get', '/usuarios/-1', cookie)).status).toBe(400);
    });
  });

  describe('edición y baja', () => {
    it('edita nombre y rol guardando el antes y después en la auditoría', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const idProfe = await insertarUsuario(migrador, { nombre_usuario: 'profe' });
      const cookie = await iniciarSesionComo(app, 'jefa');

      const res = await llamar('patch', `/usuarios/${idProfe}`, cookie, {
        rol: 'admin',
        nombre_completo: 'Nombre Nuevo',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ rol: 'admin', nombre_completo: 'Nombre Nuevo' });

      const [registro] = await auditoria('usuario_editar');
      expect(registro.entidad_id).toBe(idProfe);
      expect(registro.detalle.campos.sort()).toEqual(['nombre_completo', 'rol']);
      expect(registro.detalle.antes.rol).toBe('profesional');
      expect(registro.detalle.despues.rol).toBe('admin');
    });

    it('no acepta cuerpo vacío ni campos que no se pueden editar', async () => {
      const id = await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');
      expect((await llamar('patch', `/usuarios/${id}`, cookie, {})).status).toBe(400);
      for (const campo of [
        { nombre_usuario: 'otro' },
        { password_hash: 'x' },
        { debe_cambiar_password: false },
      ]) {
        expect((await llamar('patch', `/usuarios/${id}`, cookie, campo)).status).toBe(400);
      }
    });

    it('un administrador no puede cambiar su propio rol ni desactivarse, pero sí su nombre', async () => {
      const id = await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      await insertarUsuario(migrador, { nombre_usuario: 'otra', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');

      for (const cambio of [{ rol: 'profesional' }, { activo: false }]) {
        const res = await llamar('patch', `/usuarios/${id}`, cookie, cambio);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('AUTO_MODIFICACION');
      }
      expect((await llamar('delete', `/usuarios/${id}`, cookie)).status).toBe(422);
      expect(
        (await llamar('patch', `/usuarios/${id}`, cookie, { nombre_completo: 'Dra. Jefa' })).status,
      ).toBe(200);
    });

    it('DELETE desactiva al usuario, revoca sus sesiones y lo audita; repetirlo no duplica nada', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const idProfe = await insertarUsuario(migrador, { nombre_usuario: 'profe' });
      const cookieJefa = await iniciarSesionComo(app, 'jefa');
      const cookieProfe = await iniciarSesionComo(app, 'profe');
      expect((await llamar('get', '/auth/me', cookieProfe)).status).toBe(200);

      const res = await llamar('delete', `/usuarios/${idProfe}`, cookieJefa);
      expect(res.status).toBe(200);
      expect(res.body.activo).toBe(false);

      // Sesión revocada al instante y no puede volver a entrar
      expect((await llamar('get', '/auth/me', cookieProfe)).status).toBe(401);
      expect(
        (
          await llamar('post', '/auth/login', undefined, {
            nombre_usuario: 'profe',
            password: CLAVE_VALIDA,
          })
        ).status,
      ).toBe(401);
      expect(await auditoria('usuario_desactivar')).toHaveLength(1);

      expect((await llamar('delete', `/usuarios/${idProfe}`, cookieJefa)).status).toBe(200);
      expect(await auditoria('usuario_desactivar')).toHaveLength(1);
      // El usuario no se borra físicamente
      expect(
        (await migrador.query('SELECT 1 FROM usuario WHERE id = $1', [idProfe])).rowCount,
      ).toBe(1);
    });

    it('reactivar a un usuario bloqueado lo deja entrar de nuevo', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const idProfe = await insertarUsuario(migrador, { nombre_usuario: 'profe' });
      const cookie = await iniciarSesionComo(app, 'jefa');
      await llamar('delete', `/usuarios/${idProfe}`, cookie).expect(200);
      await migrador.query(
        "UPDATE usuario SET intentos_fallidos = 5, bloqueado_hasta = now() + interval '10 minutes' WHERE id = $1",
        [idProfe],
      );

      await llamar('patch', `/usuarios/${idProfe}`, cookie, { activo: true }).expect(200);
      await iniciarSesionComo(app, 'profe');
    });

    it('dos administradores que se desactivan a la vez nunca dejan el sistema sin administrador', async () => {
      const idA = await insertarUsuario(migrador, { nombre_usuario: 'admina', rol: 'admin' });
      const idB = await insertarUsuario(migrador, { nombre_usuario: 'adminb', rol: 'admin' });
      const cookieA = await iniciarSesionComo(app, 'admina');
      const cookieB = await iniciarSesionComo(app, 'adminb');

      const [aBaja, bBaja] = await Promise.all([
        llamar('delete', `/usuarios/${idB}`, cookieA),
        llamar('delete', `/usuarios/${idA}`, cookieB),
      ]);

      const estados = [aBaja.status, bBaja.status].sort();
      expect(estados.filter((estado) => estado === 200)).toHaveLength(1);
      const rechazada = [aBaja, bBaja].find((res) => res.status !== 200)!;
      // 422 si ya había pasado la autenticación; 401 si la otra baja revocó su sesión antes
      expect([401, 422]).toContain(rechazada.status);
      if (rechazada.status === 422) expect(rechazada.body.error.code).toBe('ULTIMO_ADMIN');

      const { rows } = await migrador.query(
        "SELECT count(*) AS activos FROM usuario WHERE rol = 'admin' AND activo",
      );
      expect(rows[0].activos).toBe(1);
    });
  });

  describe('restablecer contraseña', () => {
    it('fuerza el cambio, revoca sesiones y deja la contraseña vieja inservible', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const idProfe = await insertarUsuario(migrador, { nombre_usuario: 'profe' });
      const cookieJefa = await iniciarSesionComo(app, 'jefa');
      const cookieProfe = await iniciarSesionComo(app, 'profe');

      const res = await llamar('post', `/usuarios/${idProfe}/reset-password`, cookieJefa, {
        password_temporal: 'temporal-nueva-5678',
      });
      expect(res.status).toBe(200);
      expect(res.body.debe_cambiar_password).toBe(true);
      expect(res.body).not.toHaveProperty('password_hash');

      expect((await llamar('get', '/auth/me', cookieProfe)).status).toBe(401);
      expect(
        (
          await llamar('post', '/auth/login', undefined, {
            nombre_usuario: 'profe',
            password: CLAVE_VALIDA,
          })
        ).status,
      ).toBe(401);
      const nueva = await iniciarSesionComo(app, 'profe', 'temporal-nueva-5678');
      expect((await llamar('get', '/auth/me', nueva)).body.error.code).toBe(
        'DEBE_CAMBIAR_PASSWORD',
      );

      const [registro] = await auditoria('usuario_reset_password');
      expect(registro.entidad_id).toBe(idProfe);
      expect(JSON.stringify(registro)).not.toContain('temporal-nueva');
    });

    it('un administrador no puede restablecer su propia contraseña por esta vía', async () => {
      const id = await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');
      const res = await llamar('post', `/usuarios/${id}/reset-password`, cookie, {
        password_temporal: 'temporal-nueva-5678',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('AUTO_MODIFICACION');
    });

    it('responde 404 para un usuario inexistente y 400 para una contraseña corta', async () => {
      const id = await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'jefa');
      expect(
        (
          await llamar('post', '/usuarios/999999/reset-password', cookie, {
            password_temporal: 'temporal-nueva-5678',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await llamar('post', `/usuarios/${id}/reset-password`, cookie, {
            password_temporal: 'corta',
          })
        ).status,
      ).toBe(400);
    });
  });
});
