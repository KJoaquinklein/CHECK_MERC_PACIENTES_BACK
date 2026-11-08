import { pino, stdSerializers, type DestinationStream, type Logger } from 'pino';
import type { Env } from './env.js';

/**
 * Los errores de PostgreSQL traen `detail`, `where`, `hint` e `internalQuery`, que pueden incluir
 * los valores de las columnas (por ejemplo "Key (dni)=(30123456) already exists"): son datos
 * personales y no deben llegar al log. Se conserva solo lo que sirve para diagnosticar.
 */
const PROPIEDADES_DE_ERROR_PERMITIDAS = [
  'type',
  'message',
  'stack',
  'code',
  'constraint',
  'schema',
  'table',
  'column',
  'routine',
];

export function serializarError(error: unknown): Record<string, unknown> {
  const completo = stdSerializers.err(error as Error) as unknown as Record<string, unknown>;
  return Object.fromEntries(
    PROPIEDADES_DE_ERROR_PERMITIDAS.filter((propiedad) => propiedad in completo).map(
      (propiedad) => [propiedad, completo[propiedad]],
    ),
  );
}

/**
 * Logger sin datos personales ni clínicos: no se registran cuerpos, query strings ni encabezados
 * (ver el serializador de `req` en app.ts), se ocultan credenciales y se depuran los errores.
 */
export function crearLogger(
  env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>,
  destino?: DestinationStream,
): Logger {
  return pino(
    {
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      serializers: { err: serializarError },
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        censor: '[oculto]',
      },
    },
    destino,
  );
}
