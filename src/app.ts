import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router, type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type pg from 'pg';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Env } from './config/env.js';
import { SEGURIDAD } from './config/seguridad.js';
import { crearAutenticacion, exigirEncabezadoAjax } from './middleware/auth.js';
import { manejarErrores, rutaNoEncontrada } from './middleware/errores.js';
import { crearArchivosRouter } from './modules/archivos/archivos.routes.js';
import { crearAuditoriaRouter } from './modules/auditoria/auditoria.routes.js';
import { crearAuthRouter } from './modules/auth/auth.routes.js';
import { crearConsultasRouter } from './modules/consultas/consultas.routes.js';
import { crearObrasSocialesRouter } from './modules/obras-sociales/obras-sociales.routes.js';
import { crearPacientesRouter } from './modules/pacientes/pacientes.routes.js';
import { crearReportesRouter } from './modules/reportes/reportes.routes.js';
import { crearUsuariosRouter } from './modules/usuarios/usuarios.routes.js';
import type { StorageDriver } from './storage/driver.js';

function respuestaLimite(code: string, message: string) {
  return (_req: express.Request, res: express.Response) => {
    res.status(429).json({ error: { code, message } });
  };
}

export function crearApp(env: Env, logger: Logger, pool: pg.Pool, storage: StorageDriver): Express {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  // request_id propio (nunca el que mande el cliente) en el log y en la respuesta
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Sin query string ni cuerpo: pueden contener datos personales
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-Requested-With'],
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: respuestaLimite('DEMASIADOS_INTENTOS', 'Demasiadas peticiones, esperá un momento'),
    }),
  );
  // Límite general de 100 KB; las rutas de consultas traen su propio parser con un límite mayor
  const parserJson = express.json({ limit: '100kb' });
  const rutaConsultas = `${env.API_PREFIX}/consultas`;
  app.use((req, res, next) => {
    const esConsultas = req.path === rutaConsultas || req.path.startsWith(`${rutaConsultas}/`);
    if (esConsultas) next();
    else parserJson(req, res, next);
  });
  app.use(cookieParser());
  app.use(exigirEncabezadoAjax);

  // Más estricto que el general: frena la fuerza bruta de contraseñas por IP
  const limitadorLogin = rateLimit({
    windowMs: SEGURIDAD.LOGIN_VENTANA_MS,
    limit: env.LOGIN_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: respuestaLimite(
      'DEMASIADOS_INTENTOS',
      'Demasiados intentos de inicio de sesión, esperá unos minutos',
    ),
  });

  const autenticacion = crearAutenticacion(pool);
  const api = Router();
  api.get('/salud', (_req, res) => {
    res.json({ estado: 'ok' });
  });
  api.use(
    '/auth',
    crearAuthRouter({
      pool,
      nodeEnv: env.NODE_ENV,
      autenticar: autenticacion,
      limitadorLogin,
    }),
  );
  api.use('/usuarios', crearUsuariosRouter({ pool, autenticar: autenticacion() }));
  api.use('/obras-sociales', crearObrasSocialesRouter({ pool, autenticar: autenticacion() }));
  api.use('/pacientes', crearPacientesRouter({ pool, autenticar: autenticacion() }));
  api.use('/consultas', crearConsultasRouter({ pool, autenticar: autenticacion() }));
  api.use('/archivos', crearArchivosRouter({ pool, storage, env, autenticar: autenticacion() }));
  api.use(
    '/reportes',
    crearReportesRouter({ pool, autenticar: autenticacion(), csvSeparador: env.CSV_SEPARADOR }),
  );
  api.use('/auditoria', crearAuditoriaRouter({ pool, autenticar: autenticacion() }));
  app.use(env.API_PREFIX || '/', api);

  app.use(rutaNoEncontrada);
  app.use(manejarErrores);
  return app;
}
