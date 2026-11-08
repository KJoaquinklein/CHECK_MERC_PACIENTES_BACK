// tsc solo compila TypeScript: las migraciones .sql hay que copiarlas a dist para que
// `npm run migrar:prod` las encuentre junto al código compilado.
import { cpSync, rmSync } from 'node:fs';

rmSync('dist/db/migrations', { recursive: true, force: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('Migraciones copiadas a dist/db/migrations');
