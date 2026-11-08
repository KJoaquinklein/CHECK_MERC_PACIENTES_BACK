import { crearApp } from './app.js';
import { cargarEnv, EntornoInvalidoError, type Env } from './config/env.js';
import { crearLogger } from './config/logger.js';
import { crearPool } from './db/pool.js';
import { crearStorage } from './storage/index.js';

const TIEMPO_MAXIMO_APAGADO_MS = 10_000;

function leerEnv(): Env {
  try {
    return cargarEnv();
  } catch (error) {
    if (error instanceof EntornoInvalidoError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

function iniciar() {
  const env = leerEnv();
  const logger = crearLogger(env);
  const pool = crearPool(env, logger);
  const app = crearApp(env, logger, pool, crearStorage(env));
  const servidor = app.listen(env.PORT, () => {
    logger.info({ puerto: env.PORT, entorno: env.NODE_ENV }, 'Servidor iniciado');
  });

  let apagando = false;
  const apagar = (motivo: string, codigo = 0) => {
    if (apagando) return;
    apagando = true;
    logger.info({ motivo }, 'Apagando el servidor');
    const forzar = setTimeout(() => {
      logger.error('El apagado ordenado excedió el tiempo máximo; se fuerza la salida');
      process.exit(1);
    }, TIEMPO_MAXIMO_APAGADO_MS);
    forzar.unref();
    servidor.close(() => {
      void pool.end().finally(() => process.exit(codigo));
    });
  };

  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('SIGINT', () => apagar('SIGINT'));
  process.on('unhandledRejection', (razon) => {
    logger.fatal({ err: razon }, 'Promesa rechazada sin manejar');
    apagar('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Excepción no capturada');
    apagar('uncaughtException', 1);
  });
}

iniciar();
