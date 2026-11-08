import type { Env } from '../config/env.js';
import type { StorageDriver } from './driver.js';
import { LocalStorageDriver } from './local.driver.js';
import { S3StorageDriver } from './s3.driver.js';

export * from './driver.js';

/** Elige el driver según `STORAGE_DRIVER`. Las variables obligatorias ya las validó `cargarEnv`. */
export function crearStorage(env: Env): StorageDriver {
  if (env.STORAGE_DRIVER === 's3') {
    return new S3StorageDriver({
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION!,
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    });
  }
  return new LocalStorageDriver(env.STORAGE_LOCAL_DIR!);
}
