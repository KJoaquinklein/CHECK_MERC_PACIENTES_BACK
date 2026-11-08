import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageObjectNotFound, type OpcionesUrlFirmada, type StorageDriver } from './driver.js';

export interface ConfigS3 {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function esNoEncontrado(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return (
    error.name === 'NoSuchKey' ||
    error.name === 'NotFound' ||
    error.$metadata?.httpStatusCode === 404
  );
}

/**
 * Almacenamiento S3-compatible (Backblaze B2, Cloudflare R2, MinIO...). El bucket es privado y
 * nunca se generan URLs públicas: solo URLs firmadas de corta duración.
 */
export class S3StorageDriver implements StorageDriver {
  private readonly cliente: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigS3) {
    this.bucket = config.bucket;
    this.cliente = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Los proveedores S3-compatibles suelen exigir direcciones con el bucket en la ruta
      forcePathStyle: true,
      // Las versiones nuevas del SDK agregan checksums por defecto que varios proveedores
      // compatibles (B2, R2, MinIO viejos) rechazan: solo se calculan cuando el protocolo los exige
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(
    key: string,
    stream: Readable,
    opciones: { mime: string; size: number },
  ): Promise<void> {
    await this.cliente.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentLength: opciones.size,
        ContentType: opciones.mime,
      }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const respuesta = await this.cliente.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return respuesta.Body as Readable;
    } catch (error) {
      if (esNoEncontrado(error)) throw new StorageObjectNotFound(key);
      throw error;
    }
  }

  getSignedUrl(
    key: string,
    ttlSegundos: number,
    opciones: OpcionesUrlFirmada = {},
  ): Promise<string> {
    return getSignedUrl(
      this.cliente,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: opciones.contentType,
        ResponseContentDisposition: opciones.contentDisposition,
      }),
      { expiresIn: ttlSegundos },
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.cliente.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (esNoEncontrado(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.cliente.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
