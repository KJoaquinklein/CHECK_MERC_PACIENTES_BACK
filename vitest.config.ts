import { defineConfig } from 'vitest/config';

// Carga .env para las variables TEST_* (si el archivo no existe, no pasa nada)
try {
  process.loadEnvFile();
} catch {
  // sin .env
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    globalSetup: ['tests/globalSetup.ts'],
    // Los tests de integración comparten una sola base: no pueden correr en paralelo
    fileParallelism: false,
    // La base de pruebas es remota: la latencia varía mucho entre corridas
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
