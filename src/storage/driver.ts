import type { Readable } from 'node:stream';

/** El objeto pedido no existe en el almacenamiento. */
export class StorageObjectNotFound extends Error {
  constructor(public readonly key: string) {
    super(`No existe el objeto "${key}" en el almacenamiento`);
    this.name = 'StorageObjectNotFound';
  }
}

/** La operación no está disponible en este driver (ej. URLs firmadas en el driver local). */
export class StorageOperationNotSupported extends Error {
  constructor(operacion: string) {
    super(`El driver de almacenamiento no soporta "${operacion}"`);
    this.name = 'StorageOperationNotSupported';
  }
}

export interface OpcionesUrlFirmada {
  /** Tipo de contenido con el que el almacenamiento debe responder. */
  contentType?: string;
  /** Valor del encabezado Content-Disposition de la respuesta. */
  contentDisposition?: string;
}

/**
 * Almacenamiento de los binarios. Los objetos son inmutables: `put` nunca sobrescribe una clave
 * existente porque cada clave lleva un uuid nuevo.
 */
export interface StorageDriver {
  put(key: string, stream: Readable, opciones: { mime: string; size: number }): Promise<void>;
  /** Lanza `StorageObjectNotFound` si no existe. */
  getStream(key: string): Promise<Readable>;
  /** Lanza `StorageOperationNotSupported` si el driver no puede firmar URLs. */
  getSignedUrl(key: string, ttlSegundos: number, opciones?: OpcionesUrlFirmada): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Solo para scripts de mantenimiento y para deshacer una subida fallida; la API no lo expone. */
  delete(key: string): Promise<void>;
}
