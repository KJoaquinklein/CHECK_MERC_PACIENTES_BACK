import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { opcionesSsl } from './pool.js';

const DIRECTORIO_MIGRACIONES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/** Aplica o revierte migraciones. Debe usarse con la conexión del rol hc_migrator. */
export async function ejecutarMigraciones(opciones: {
  url: string;
  ssl: boolean;
  direccion: 'up' | 'down';
  /** Cantidad de migraciones; por defecto todas las pendientes (up) o todas (down). */
  cantidad?: number;
  silencioso?: boolean;
}) {
  return runner({
    databaseUrl: { connectionString: opciones.url, ssl: opcionesSsl(opciones.ssl) },
    dir: DIRECTORIO_MIGRACIONES,
    migrationsTable: 'pgmigrations',
    direction: opciones.direccion,
    count: opciones.cantidad ?? (opciones.direccion === 'down' ? Infinity : undefined),
    checkOrder: true,
    verbose: false,
    log: opciones.silencioso ? () => {} : (msg) => console.log(msg),
  });
}
