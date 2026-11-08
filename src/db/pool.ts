import pg from 'pg';
import type { Logger } from 'pino';

// bigint (ids y count(*)) llega como número: los ids nunca se acercan a 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (valor) => Number(valor));
// date llega como 'YYYY-MM-DD' (sin convertir a Date, que lo corre de día según la zona horaria).
pg.types.setTypeParser(pg.types.builtins.DATE, (valor) => valor);

export type Ejecutor = Pick<pg.Pool | pg.PoolClient, 'query'>;

export function opcionesSsl(ssl: boolean): pg.ClientConfig['ssl'] {
  return ssl ? { rejectUnauthorized: true } : false;
}

export function crearPool(
  config: { DATABASE_URL: string; DATABASE_SSL: boolean },
  logger?: Logger,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: opcionesSsl(config.DATABASE_SSL),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'historias-clinicas-api',
  });
  // Un error en una conexión ociosa no debe tumbar el proceso
  pool.on('error', (err) => {
    logger?.error({ err }, 'Error en una conexión ociosa del pool');
  });
  return pool;
}
