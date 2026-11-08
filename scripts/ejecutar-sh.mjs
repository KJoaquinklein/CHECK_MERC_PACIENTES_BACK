// Lanza un script .sh cargando antes el archivo .env (si existe), para que `npm run backup` y
// `npm run restaurar` usen las mismas variables que el resto del proyecto.
// Uso: node scripts/ejecutar-sh.mjs scripts/backup.sh [argumentos]
import { spawnSync } from 'node:child_process';

try {
  process.loadEnvFile();
} catch {
  // sin .env: se usan las variables que ya estén definidas
}

const [script, ...argumentos] = process.argv.slice(2);
if (!script) {
  console.error('Indicá qué script ejecutar.');
  process.exit(1);
}
const resultado = spawnSync('bash', [script, ...argumentos], { stdio: 'inherit' });
if (resultado.error) {
  console.error(`No se pudo ejecutar bash: ${resultado.error.message}`);
  console.error('Estos scripts necesitan bash (Linux, macOS o Git Bash en Windows).');
  process.exit(1);
}
process.exit(resultado.status ?? 1);
