import type { CookieOptions, RequestHandler } from 'express';
import type pg from 'pg';
import { COOKIE_SESION, SEGURIDAD } from '../config/seguridad.js';
import { AppError, errores } from '../errors.js';
import { tocarSesionActiva } from '../modules/auth/auth.repo.js';
import { hashDeToken } from '../modules/auth/auth.service.js';
import type { Rol } from '../modules/auth/auth.types.js';

const FORMATO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Cookie de sesión: httpOnly, Secure y SameSite=Strict (en tests se omite Secure por usar http). */
export function opcionesCookieSesion(nodeEnv: string): CookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnv !== 'test',
    sameSite: 'strict',
    path: '/',
  };
}

/**
 * Exige una sesión vigente y carga `req.usuario`. Si el usuario debe cambiar su contraseña, solo
 * deja pasar las rutas que declaran `permitirCambioPendiente`.
 */
export function crearAutenticacion(pool: pg.Pool) {
  return function autenticar(opciones: { permitirCambioPendiente?: boolean } = {}): RequestHandler {
    return async (req, _res, next) => {
      const token: unknown = req.cookies?.[COOKIE_SESION];
      if (typeof token !== 'string' || !FORMATO_TOKEN.test(token)) throw errores.noAutenticado();

      const sesion = await tocarSesionActiva(
        pool,
        hashDeToken(token),
        SEGURIDAD.SESION_INACTIVIDAD_MINUTOS,
      );
      if (!sesion) throw errores.noAutenticado();

      if (sesion.usuario.debe_cambiar_password && !opciones.permitirCambioPendiente) {
        throw new AppError(
          403,
          'DEBE_CAMBIAR_PASSWORD',
          'Tenés que cambiar tu contraseña antes de continuar',
        );
      }
      req.usuario = sesion.usuario;
      req.sesionId = sesion.sesionId;
      next();
    };
  };
}

/** Permite el paso solo a los roles indicados. Debe ir después de `autenticar`. */
export function requerirRol(...roles: Rol[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.usuario) throw errores.noAutenticado();
    if (!roles.includes(req.usuario.rol)) throw errores.prohibido();
    next();
  };
}

/**
 * Defensa contra CSRF además de SameSite=Strict: los métodos que modifican datos exigen un
 * encabezado personalizado, que un formulario de otro sitio no puede enviar.
 */
export const exigirEncabezadoAjax: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.get('X-Requested-With')) {
    throw new AppError(403, 'CSRF', 'Falta el encabezado X-Requested-With');
  }
  next();
};
