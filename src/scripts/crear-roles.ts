import pg from 'pg';
import { opcionesSsl } from '../db/pool.js';

// Crea (o actualiza las contraseñas de) los roles hc_migrator y hc_app y les da acceso a la base.
// Se ejecuta una sola vez por base, con un usuario administrador (el que da el hosting).
//   ADMIN_DATABASE_URL    conexión del usuario administrador
//   HC_MIGRATOR_PASSWORD  contraseña para hc_migrator
//   HC_APP_PASSWORD       contraseña para hc_app
const { ADMIN_DATABASE_URL, HC_MIGRATOR_PASSWORD, HC_APP_PASSWORD } = process.env;
if (!ADMIN_DATABASE_URL || !HC_MIGRATOR_PASSWORD || !HC_APP_PASSWORD) {
  console.error('Faltan ADMIN_DATABASE_URL, HC_MIGRATOR_PASSWORD o HC_APP_PASSWORD.');
  process.exit(1);
}
if (HC_MIGRATOR_PASSWORD.length < 16 || HC_APP_PASSWORD.length < 16) {
  console.error('Las contraseñas de los roles deben tener al menos 16 caracteres.');
  process.exit(1);
}
if (HC_MIGRATOR_PASSWORD === HC_APP_PASSWORD) {
  console.error('Las contraseñas de hc_migrator y hc_app deben ser distintas.');
  process.exit(1);
}

const cliente = new pg.Client({
  connectionString: ADMIN_DATABASE_URL,
  ssl: opcionesSsl(process.env.DATABASE_SSL === 'true'),
});

/** Los comandos de rol no aceptan parámetros: la contraseña se escapa con format(%L). */
async function ejecutarFormateado(plantilla: string, ...valores: string[]) {
  const { rows } = await cliente.query<{ sql: string }>(
    'SELECT format($1, VARIADIC $2::text[]) AS sql',
    [plantilla, valores],
  );
  await cliente.query(rows[0]!.sql);
}

try {
  await cliente.connect();
  const { rows } = await cliente.query<{ base: string }>('SELECT current_database() AS base');
  const base = rows[0]!.base;

  for (const [rol, clave] of [
    ['hc_migrator', HC_MIGRATOR_PASSWORD],
    ['hc_app', HC_APP_PASSWORD],
  ] as const) {
    const existe = await cliente.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [rol]);
    await ejecutarFormateado(
      existe.rowCount ? 'ALTER ROLE %I LOGIN PASSWORD %L' : 'CREATE ROLE %I LOGIN PASSWORD %L',
      rol,
      clave,
    );
  }

  // Ni la app ni nadie más puede crear objetos en public; solo el migrador
  await cliente.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await ejecutarFormateado('GRANT CONNECT ON DATABASE %I TO hc_app, hc_migrator', base);
  await ejecutarFormateado('GRANT CREATE ON DATABASE %I TO hc_migrator', base);
  await cliente.query('GRANT USAGE, CREATE ON SCHEMA public TO hc_migrator');
  await cliente.query('GRANT USAGE ON SCHEMA public TO hc_app');

  console.log(`Roles hc_migrator y hc_app listos en la base "${base}".`);
} catch (error) {
  console.error('No se pudieron crear los roles:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
