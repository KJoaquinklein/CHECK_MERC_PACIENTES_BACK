import { ejecutarMigraciones } from '../src/db/migrar.js';
import { configBasePruebas } from './utilidades/db.js';

/** Deja la base de pruebas con el esquema recién migrado desde cero (una vez por corrida). */
export default async function globalSetup() {
  const config = configBasePruebas();
  if (!config) return;
  const base = { url: config.urlMigrador, ssl: config.ssl, silencioso: true };
  await ejecutarMigraciones({ ...base, direccion: 'down' });
  await ejecutarMigraciones({ ...base, direccion: 'up' });
}
