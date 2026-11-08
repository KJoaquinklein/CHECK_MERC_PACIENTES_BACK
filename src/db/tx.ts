import type pg from 'pg';

/**
 * Ejecuta `fn` dentro de una transacción: COMMIT si termina bien, ROLLBACK si lanza.
 * Todo lo que deba ser atómico (por ejemplo un cambio y su auditoría) va en la misma `fn`.
 */
export async function conTransaccion<T>(
  pool: pg.Pool,
  fn: (cliente: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await pool.connect();
  // Si el ROLLBACK falla la conexión queda inutilizable: se descarta en vez de volver al pool
  let conexionRota: Error | undefined;
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    try {
      await cliente.query('ROLLBACK');
    } catch (errorRollback) {
      conexionRota = errorRollback as Error;
    }
    throw error;
  } finally {
    cliente.release(conexionRota);
  }
}
