import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  StorageObjectNotFound,
  StorageOperationNotSupported,
  type StorageDriver,
} from './driver.js';

/** Guarda los objetos en una carpeta del disco. Solo para desarrollo y tests. */
export class LocalStorageDriver implements StorageDriver {
  private readonly base: string;

  constructor(directorio: string) {
    this.base = path.resolve(directorio);
  }

  /** Resuelve la ruta y se asegura de que quede dentro de la carpeta base. */
  private rutaDe(key: string): string {
    if (!key || key.includes('\0') || key.includes('\\') || path.isAbsolute(key)) {
      throw new Error('Clave de almacenamiento inválida');
    }
    const ruta = path.resolve(this.base, key);
    if (!ruta.startsWith(this.base + path.sep)) throw new Error('Clave de almacenamiento inválida');
    return ruta;
  }

  async put(
    key: string,
    stream: Readable,
    _opciones?: { mime: string; size: number },
  ): Promise<void> {
    const destino = this.rutaDe(key);
    await mkdir(path.dirname(destino), { recursive: true });
    // Se escribe en un archivo temporal y se renombra: nunca queda un objeto a medio escribir
    const temporal = `${destino}.${randomUUID()}.parcial`;
    try {
      await pipeline(stream, createWriteStream(temporal, { flags: 'wx' }));
      await rename(temporal, destino);
    } catch (error) {
      await rm(temporal, { force: true });
      throw error;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const ruta = this.rutaDe(key);
    try {
      await stat(ruta);
    } catch {
      throw new StorageObjectNotFound(key);
    }
    return createReadStream(ruta);
  }

  getSignedUrl(): Promise<string> {
    return Promise.reject(new StorageOperationNotSupported('getSignedUrl'));
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.rutaDe(key))).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.rutaDe(key), { force: true });
  }
}
