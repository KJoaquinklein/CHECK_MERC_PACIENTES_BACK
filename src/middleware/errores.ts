import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, errores } from '../errors.js';

export const rutaNoEncontrada: RequestHandler = (_req, _res, next) => {
  next(errores.noEncontrado('La ruta solicitada no existe'));
};

function enviar(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  res.status(status).json({ error: { code, message, ...extra } });
}

/**
 * Convierte cualquier error en la respuesta estándar. Los errores internos devuelven un
 * mensaje genérico con el request_id; el detalle va solo al log.
 */
export const manejarErrores: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (res.headersSent) {
    req.socket.destroy();
    return;
  }

  if (err instanceof AppError) {
    enviar(res, err.status, err.code, err.message, err.details ? { details: err.details } : {});
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message }));
    enviar(res, 400, 'VALIDACION', 'Los datos enviados no son válidos', { details });
    return;
  }

  // Errores de body-parser (JSON malformado, body demasiado grande)
  const tipo = (err as { type?: string } | null)?.type;
  if (tipo === 'entity.parse.failed') {
    enviar(res, 400, 'VALIDACION', 'El cuerpo de la petición no es un JSON válido');
    return;
  }
  if (tipo === 'entity.too.large') {
    enviar(res, 413, 'PAYLOAD_DEMASIADO_GRANDE', 'El cuerpo de la petición supera el límite');
    return;
  }

  req.log.error({ err }, 'Error interno no controlado');
  enviar(
    res,
    500,
    'ERROR_INTERNO',
    'Ocurrió un error interno. Informá el request_id si persiste.',
    {
      request_id: String(req.id),
    },
  );
};
