import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { COOKIE_SESION, SEGURIDAD } from '../../config/seguridad.js';
import { opcionesCookieSesion } from '../../middleware/auth.js';
import { ipDe } from '../auditoria/auditoria.service.js';
import { esquemaCambiarPassword, esquemaLogin } from './auth.schemas.js';
import { cambiarPassword, cerrarSesion, iniciarSesion } from './auth.service.js';

type Autenticar = (opciones?: { permitirCambioPendiente?: boolean }) => RequestHandler;

export function crearAuthRouter(deps: {
  pool: pg.Pool;
  nodeEnv: string;
  autenticar: Autenticar;
  limitadorLogin: RequestHandler;
}): Router {
  const { pool, nodeEnv, autenticar, limitadorLogin } = deps;
  const router = Router();
  const cookie = opcionesCookieSesion(nodeEnv);

  router.post('/login', limitadorLogin, async (req, res) => {
    const datos = esquemaLogin.parse(req.body);
    const { token, usuario } = await iniciarSesion(pool, datos, {
      ip: ipDe(req),
      userAgent: req.get('User-Agent') ?? null,
    });
    res.cookie(COOKIE_SESION, token, {
      ...cookie,
      maxAge: SEGURIDAD.SESION_DURACION_HORAS * 3_600_000,
    });
    res.json({
      id: usuario.id,
      nombre_usuario: usuario.nombre_usuario,
      nombre_completo: usuario.nombre_completo,
      rol: usuario.rol,
      debe_cambiar_password: usuario.debe_cambiar_password,
    });
  });

  // Con el cambio de contraseña pendiente solo se puede cambiarla o cerrar sesión
  router.post('/logout', autenticar({ permitirCambioPendiente: true }), async (req, res) => {
    await cerrarSesion(pool, req.usuario!.id, req.sesionId!, ipDe(req));
    res.clearCookie(COOKIE_SESION, cookie);
    res.status(204).end();
  });

  router.get('/me', autenticar(), (req, res) => {
    res.json(req.usuario);
  });

  router.post(
    '/cambiar-password',
    limitadorLogin,
    autenticar({ permitirCambioPendiente: true }),
    async (req, res) => {
      const datos = esquemaCambiarPassword.parse(req.body);
      const usuario = await cambiarPassword(pool, req.usuario!.id, req.sesionId!, datos, ipDe(req));
      res.json(usuario);
    },
  );

  return router;
}
