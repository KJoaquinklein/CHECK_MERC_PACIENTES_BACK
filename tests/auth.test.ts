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

describe.skipIf(!config)('autenticación (PostgreSQL real)', () => {
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

  const login = (nombre_usuario: string, password: string) =>
    request(app).post('/auth/login').set(ENCABEZADO_AJAX).send({ nombre_usuario, password });

  async function auditoria(accion: string) {
    const { rows } = await migrador.query(
      'SELECT id_usuario, entidad_id, detalle FROM auditoria WHERE accion = $1 ORDER BY id',
      [accion],
    );
    return rows;
  }

  describe('login', () => {
    it('crea la sesión con cookie httpOnly y SameSite=Strict, sin exponer hashes', async () => {
      const id = await insertarUsuario(migrador, { nombre_usuario: 'doctora', rol: 'admin' });
      const res = await login('doctora', CLAVE_VALIDA);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id,
        nombre_usuario: 'doctora',
        nombre_completo: 'Usuario doctora',
        rol: 'admin',
        debe_cambiar_password: false,
      });
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
      expect(cookie).toMatch(/^sid=[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');

      // En la base solo se guarda el sha256 del token, nunca el token
      const token = cookie.split(';')[0]!.slice(4);
      const { rows } = await migrador.query('SELECT token_hash FROM sesion');
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toHaveLength(64);
      expect(rows[0].token_hash).not.toBe(token);

      expect(await auditoria('login_ok')).toHaveLength(1);
    });

    it('el nombre de usuario no distingue mayúsculas', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      expect((await login('  DOCTORA ', CLAVE_VALIDA)).status).toBe(200);
    });

    it('responde lo mismo si el usuario no existe o la contraseña es incorrecta, y lo audita', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      const inexistente = await login('fantasma', 'cualquier-clave-123');
      const incorrecta = await login('doctora', 'cualquier-clave-123');

      expect(inexistente.status).toBe(401);
      expect(incorrecta.status).toBe(401);
      expect(inexistente.body).toEqual(incorrecta.body);
      expect(incorrecta.body.error).toEqual({
        code: 'CREDENCIALES_INVALIDAS',
        message: 'Credenciales inválidas',
      });
      expect(incorrecta.headers['set-cookie']).toBeUndefined();

      const fallidos = await auditoria('login_fallido');
      expect(fallidos).toHaveLength(2);
      expect(fallidos.map((f) => f.detalle.motivo)).toEqual([
        'usuario_inexistente',
        'credenciales',
      ]);
      // No se guarda lo que se tipeó
      expect(JSON.stringify(fallidos)).not.toContain('fantasma');
      expect(JSON.stringify(fallidos)).not.toContain('cualquier-clave');
    });

    it('bloquea 15 minutos tras 5 fallos seguidos, incluso con la contraseña correcta', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      for (let i = 0; i < 5; i++) await login('doctora', 'clave-incorrecta-123');

      const bloqueado = await login('doctora', CLAVE_VALIDA);
      expect(bloqueado.status).toBe(401);
      expect(bloqueado.body.error.code).toBe('CREDENCIALES_INVALIDAS');

      const { rows } = await migrador.query(
        `SELECT intentos_fallidos, bloqueado_hasta > now() + interval '14 minutes' AS bloqueo_largo
         FROM usuario`,
      );
      expect(rows[0]).toEqual({ intentos_fallidos: 5, bloqueo_largo: true });
      expect((await auditoria('login_fallido')).at(-1)!.detalle.motivo).toBe('usuario_bloqueado');
    });

    it('un intento durante el bloqueo no lo extiende', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      for (let i = 0; i < 5; i++) await login('doctora', 'clave-incorrecta-123');
      const antes = await migrador.query('SELECT bloqueado_hasta FROM usuario');
      await login('doctora', 'clave-incorrecta-123');
      const despues = await migrador.query('SELECT bloqueado_hasta FROM usuario');
      expect(despues.rows[0].bloqueado_hasta).toEqual(antes.rows[0].bloqueado_hasta);
    });

    it('al vencer el bloqueo se puede entrar y el contador vuelve a cero', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      for (let i = 0; i < 5; i++) await login('doctora', 'clave-incorrecta-123');
      await migrador.query("UPDATE usuario SET bloqueado_hasta = now() - interval '1 minute'");

      expect((await login('doctora', CLAVE_VALIDA)).status).toBe(200);
      const { rows } = await migrador.query(
        'SELECT intentos_fallidos, bloqueado_hasta FROM usuario',
      );
      expect(rows[0]).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
    });

    it('tras un bloqueo vencido, un fallo cuenta como el primero (no vuelve a bloquear)', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      for (let i = 0; i < 5; i++) await login('doctora', 'clave-incorrecta-123');
      await migrador.query("UPDATE usuario SET bloqueado_hasta = now() - interval '1 minute'");

      await login('doctora', 'clave-incorrecta-123');
      const { rows } = await migrador.query(
        'SELECT intentos_fallidos, bloqueado_hasta FROM usuario',
      );
      expect(rows[0]).toEqual({ intentos_fallidos: 1, bloqueado_hasta: null });
    });

    it('un login correcto reinicia el contador de fallos', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      for (let i = 0; i < 3; i++) await login('doctora', 'clave-incorrecta-123');
      expect((await login('doctora', CLAVE_VALIDA)).status).toBe(200);
      const { rows } = await migrador.query('SELECT intentos_fallidos FROM usuario');
      expect(rows[0].intentos_fallidos).toBe(0);
    });

    it('un usuario inactivo no puede iniciar sesión', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'baja', activo: false });
      const res = await login('baja', CLAVE_VALIDA);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('CREDENCIALES_INVALIDAS');
    });

    it('rechaza campos desconocidos y cuerpos incompletos', async () => {
      const extra = await request(app)
        .post('/auth/login')
        .set(ENCABEZADO_AJAX)
        .send({ nombre_usuario: 'a', password: 'b', rol: 'admin' });
      expect(extra.status).toBe(400);
      const vacio = await request(app).post('/auth/login').set(ENCABEZADO_AJAX).send({});
      expect(vacio.status).toBe(400);
      expect(vacio.body.error.code).toBe('VALIDACION');
    });

    it('exige el encabezado X-Requested-With en métodos que modifican datos (CSRF)', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ nombre_usuario: 'a', password: 'b' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF');
    });

    it('limita los intentos de login por IP', async () => {
      const limitada = crearAppDePrueba(config!, { LOGIN_RATE_LIMIT_MAX: '3' });
      try {
        const estados: number[] = [];
        for (let i = 0; i < 4; i++) {
          const res = await request(limitada.app)
            .post('/auth/login')
            .set(ENCABEZADO_AJAX)
            .send({ nombre_usuario: 'nadie', password: 'x' });
          estados.push(res.status);
        }
        expect(estados).toEqual([401, 401, 401, 429]);
      } finally {
        await limitada.pool.end();
      }
    });
  });

  describe('sesión', () => {
    it('GET /auth/me devuelve el usuario de la sesión', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora', rol: 'admin' });
      const cookie = await iniciarSesionComo(app, 'doctora');
      const res = await request(app).get('/auth/me').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.nombre_usuario).toBe('doctora');
      expect(res.body).not.toHaveProperty('password_hash');
    });

    it('sin cookie, o con una cookie inventada, responde 401', async () => {
      expect((await request(app).get('/auth/me')).status).toBe(401);
      const falsa = await request(app)
        .get('/auth/me')
        .set('Cookie', `sid=${'a'.repeat(43)}`);
      expect(falsa.status).toBe(401);
      const basura = await request(app)
        .get('/auth/me')
        .set('Cookie', "sid='; DROP TABLE usuario;--");
      expect(basura.status).toBe(401);
    });

    it('una sesión vencida (12 horas) deja de valer', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      const cookie = await iniciarSesionComo(app, 'doctora');
      await migrador.query("UPDATE sesion SET expira_en = now() - interval '1 second'");
      expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
    });

    it('una sesión sin uso por más de 120 minutos deja de valer; el uso la renueva', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      const cookie = await iniciarSesionComo(app, 'doctora');

      await migrador.query("UPDATE sesion SET ultimo_uso = now() - interval '119 minutes'");
      expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
      const { rows } = await migrador.query(
        "SELECT ultimo_uso > now() - interval '1 minute' AS renovada FROM sesion",
      );
      expect(rows[0].renovada).toBe(true);

      await migrador.query("UPDATE sesion SET ultimo_uso = now() - interval '121 minutes'");
      expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
    });

    it('logout revoca la sesión y queda auditado', async () => {
      const id = await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      const cookie = await iniciarSesionComo(app, 'doctora');

      const res = await request(app)
        .post('/auth/logout')
        .set(ENCABEZADO_AJAX)
        .set('Cookie', cookie);
      expect(res.status).toBe(204);
      expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
      expect((await auditoria('logout'))[0].id_usuario).toBe(id);
    });
  });

  describe('contraseña', () => {
    it('con el cambio pendiente solo se puede cambiar la contraseña o cerrar sesión', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'nueva', debe_cambiar_password: true });
      const cookie = await iniciarSesionComo(app, 'nueva');

      const me = await request(app).get('/auth/me').set('Cookie', cookie);
      expect(me.status).toBe(403);
      expect(me.body.error.code).toBe('DEBE_CAMBIAR_PASSWORD');
      const usuarios = await request(app).get('/usuarios').set('Cookie', cookie);
      expect(usuarios.status).toBe(403);
      expect(usuarios.body.error.code).toBe('DEBE_CAMBIAR_PASSWORD');

      const cambio = await request(app)
        .post('/auth/cambiar-password')
        .set(ENCABEZADO_AJAX)
        .set('Cookie', cookie)
        .send({ actual: CLAVE_VALIDA, nueva: 'otra-clave-muy-larga-99' });
      expect(cambio.status).toBe(200);
      expect(cambio.body.debe_cambiar_password).toBe(false);
      expect(cambio.body).not.toHaveProperty('password_hash');

      expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
      expect((await login('nueva', CLAVE_VALIDA)).status).toBe(401);
      expect((await login('nueva', 'otra-clave-muy-larga-99')).status).toBe(200);
      expect(JSON.stringify(await auditoria('cambio_password'))).not.toContain('otra-clave');
    });

    it('valida la política: mínimo 10 caracteres, actual correcta y distinta de la anterior', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      const cookie = await iniciarSesionComo(app, 'doctora');
      const cambiar = (actual: string, nueva: string) =>
        request(app)
          .post('/auth/cambiar-password')
          .set(ENCABEZADO_AJAX)
          .set('Cookie', cookie)
          .send({ actual, nueva });

      const corta = await cambiar(CLAVE_VALIDA, 'corta123');
      expect(corta.status).toBe(400);
      expect(corta.body.error.code).toBe('VALIDACION');

      const equivocada = await cambiar('no-es-la-actual-123', 'otra-clave-muy-larga-99');
      expect(equivocada.status).toBe(422);
      expect(equivocada.body.error.code).toBe('PASSWORD_ACTUAL_INCORRECTA');

      const repetida = await cambiar(CLAVE_VALIDA, CLAVE_VALIDA);
      expect(repetida.status).toBe(422);
      expect(repetida.body.error.code).toBe('PASSWORD_REPETIDA');
    });

    it('al cambiar la contraseña se cierran las demás sesiones del usuario', async () => {
      await insertarUsuario(migrador, { nombre_usuario: 'doctora' });
      const actual = await iniciarSesionComo(app, 'doctora');
      const otra = await iniciarSesionComo(app, 'doctora');

      await request(app)
        .post('/auth/cambiar-password')
        .set(ENCABEZADO_AJAX)
        .set('Cookie', actual)
        .send({ actual: CLAVE_VALIDA, nueva: 'otra-clave-muy-larga-99' })
        .expect(200);

      expect((await request(app).get('/auth/me').set('Cookie', actual)).status).toBe(200);
      expect((await request(app).get('/auth/me').set('Cookie', otra)).status).toBe(401);
    });
  });
});
