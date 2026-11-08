import { ejecutarMigraciones } from '../db/migrar.js';

// Uso: npm run migrar            (aplica las pendientes)
//      npm run migrar -- down 1  (revierte la última; solo para desarrollo)
const url = process.env.MIGRATIONS_DATABASE_URL;
if (!url) {
  console.error('Falta MIGRATIONS_DATABASE_URL (conexión del rol hc_migrator).');
  process.exit(1);
}

const direccion = process.argv[2] === 'down' ? 'down' : 'up';
const cantidad = process.argv[3] ? Number(process.argv[3]) : undefined;
if (cantidad !== undefined && !Number.isInteger(cantidad)) {
  console.error('La cantidad de migraciones debe ser un número entero.');
  process.exit(1);
}
if (direccion === 'down' && process.env.NODE_ENV === 'production') {
  console.error('Revertir migraciones no está permitido en producción.');
  process.exit(1);
}

try {
  const aplicadas = await ejecutarMigraciones({
    url,
    ssl: process.env.DATABASE_SSL === 'true',
    direccion,
    cantidad,
  });
  console.log(
    `Listo: ${aplicadas.length} migración(es) ${direccion === 'up' ? 'aplicada(s)' : 'revertida(s)'}.`,
  );
} catch (error) {
  console.error('Falló la migración:', error instanceof Error ? error.message : error);
  process.exit(1);
}
