import pg from 'pg';
import { crearPool } from '../../src/db/pool.js';

export interface ConfigBasePruebas {
  /** Conexión como hc_app (la que usa la API). */
  urlApp: string;
  /** Conexión como hc_migrator (migraciones y limpieza). */
  urlMigrador: string;
  ssl: boolean;
}

/**
 * Los tests borran todos los datos: solo corren contra una base cuyo nombre indique que es de
 * pruebas. Nunca se reutiliza DATABASE_URL.
 */
function validarNombreDeBase(url: string, variable: string) {
  const base = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/(test|prueba|dev|desarrollo)/i.test(base)) {
    throw new Error(
      `${variable} apunta a la base "${base}": el nombre debe contener "test", "prueba", "dev" o ` +
        '"desarrollo" para evitar borrar datos reales.',
    );
  }
}

/** Devuelve null si no hay base de pruebas configurada (los tests de integración se omiten). */
export function configBasePruebas(): ConfigBasePruebas | null {
  const urlApp = process.env.TEST_DATABASE_URL;
  const urlMigrador = process.env.TEST_MIGRATIONS_DATABASE_URL;
  if (!urlApp || !urlMigrador) return null;
  validarNombreDeBase(urlApp, 'TEST_DATABASE_URL');
  validarNombreDeBase(urlMigrador, 'TEST_MIGRATIONS_DATABASE_URL');
  return { urlApp, urlMigrador, ssl: process.env.TEST_DATABASE_SSL === 'true' };
}

export function poolApp(config: ConfigBasePruebas): pg.Pool {
  return crearPool({ DATABASE_URL: config.urlApp, DATABASE_SSL: config.ssl });
}

export function poolMigrador(config: ConfigBasePruebas): pg.Pool {
  return crearPool({ DATABASE_URL: config.urlMigrador, DATABASE_SSL: config.ssl });
}

/** Vacía todas las tablas de datos y reinicia los ids. Se usa con el pool del migrador. */
export async function limpiarDatos(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DO $$
    DECLARE tablas text;
    BEGIN
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO tablas
      FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations';
      EXECUTE 'TRUNCATE ' || tablas || ' RESTART IDENTITY CASCADE';
    END
    $$;
  `);
}

/**
 * Vacía solo los datos clínicos y la auditoría, conservando usuarios y sesiones: permite iniciar
 * sesión una sola vez por archivo de tests (cada login cuesta una verificación argon2).
 */
export async function limpiarDatosClinicos(pool: pg.Pool): Promise<void> {
  // TRUNCATE toma bloqueos exclusivos sobre varias tablas. Si una petición del test anterior
  // sigue en vuelo (por ejemplo, tras un timeout por lentitud de la red), PostgreSQL puede
  // abortar uno de los dos por deadlock: se reintenta en lugar de arrastrar al test siguiente.
  for (let intento = 1; ; intento++) {
    try {
      await pool.query(
        `TRUNCATE obra_social, paciente, consulta, consulta_contenido, paciente_archivo, auditoria
         RESTART IDENTITY CASCADE`,
      );
      return;
    } catch (error) {
      const esDeadlock = (error as { code?: string }).code === '40P01';
      if (!esDeadlock || intento >= 5) throw error;
      await new Promise((resolver) => setTimeout(resolver, 1000 * intento));
    }
  }
}
