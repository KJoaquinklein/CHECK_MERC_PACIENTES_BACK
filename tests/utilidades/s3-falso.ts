import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3StorageDriver, type ConfigS3 } from '../../src/storage/s3.driver.js';
import type { StorageDriver } from '../../src/storage/driver.js';

interface ObjetoFalso {
  cuerpo: Buffer;
  contentType: string;
}

/**
 * Servidor HTTP que imita lo mínimo de la API de S3 (direcciones con el bucket en la ruta):
 * PUT, GET, HEAD y DELETE de objetos. El cliente que se prueba es el SDK real de AWS, de modo
 * que se ejercita el mismo código que en producción sin necesitar Docker ni una cuenta externa.
 */
export class S3Falso {
  readonly objetos = new Map<string, ObjetoFalso>();
  private servidor: Server | undefined;
  endpoint = '';

  async iniciar(): Promise<void> {
    this.servidor = createServer((req, res) => {
      void this.atender(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolver) => this.servidor!.listen(0, '127.0.0.1', resolver));
    this.endpoint = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}`;
  }

  async detener(): Promise<void> {
    await new Promise<void>((resolver) => {
      this.servidor?.closeAllConnections();
      if (this.servidor) this.servidor.close(() => resolver());
      else resolver();
    });
  }

  private async atender(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', this.endpoint);
    const clave = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ''));
    const noExiste = () => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/xml');
      res.end(
        '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>no existe</Message></Error>',
      );
    };

    if (req.method === 'PUT') {
      const partes: Buffer[] = [];
      for await (const parte of req) partes.push(parte as Buffer);
      this.objetos.set(clave, {
        cuerpo: Buffer.concat(partes),
        contentType: req.headers['content-type'] ?? 'application/octet-stream',
      });
      res.statusCode = 200;
      res.setHeader('ETag', '"falso"');
      res.end();
      return;
    }
    const objeto = this.objetos.get(clave);
    if (req.method === 'DELETE') {
      this.objetos.delete(clave);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!objeto) return noExiste();
    // Como S3, respeta los parámetros response-* de las URLs firmadas
    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      url.searchParams.get('response-content-type') ?? objeto.contentType,
    );
    const disposicion = url.searchParams.get('response-content-disposition');
    if (disposicion) res.setHeader('Content-Disposition', disposicion);
    res.setHeader('Content-Length', String(objeto.cuerpo.length));
    res.end(req.method === 'HEAD' ? undefined : objeto.cuerpo);
  }
}

export interface ConfigS3Prueba {
  config: ConfigS3;
  /** true si es un bucket real configurado con TEST_S3_*; false si es el servidor simulado. */
  esReal: boolean;
}

/** Configuración S3 para los tests: un bucket real de pruebas si hay TEST_S3_*, si no el simulado. */
export function configS3DePrueba(falso: S3Falso): ConfigS3Prueba {
  const { TEST_S3_ENDPOINT, TEST_S3_REGION, TEST_S3_BUCKET } = process.env;
  const { TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY } = process.env;
  if (
    TEST_S3_ENDPOINT &&
    TEST_S3_REGION &&
    TEST_S3_BUCKET &&
    TEST_S3_ACCESS_KEY_ID &&
    TEST_S3_SECRET_ACCESS_KEY
  ) {
    return {
      esReal: true,
      config: {
        endpoint: TEST_S3_ENDPOINT,
        region: TEST_S3_REGION,
        bucket: TEST_S3_BUCKET,
        accessKeyId: TEST_S3_ACCESS_KEY_ID,
        secretAccessKey: TEST_S3_SECRET_ACCESS_KEY,
      },
    };
  }
  return {
    esReal: false,
    config: {
      endpoint: falso.endpoint,
      region: 'us-east-1',
      bucket: 'bucket-de-prueba',
      accessKeyId: 'clave-de-prueba',
      secretAccessKey: 'secreto-de-prueba',
    },
  };
}

export function crearS3DePrueba(falso: S3Falso): { storage: StorageDriver } & ConfigS3Prueba {
  const configuracion = configS3DePrueba(falso);
  return { ...configuracion, storage: new S3StorageDriver(configuracion.config) };
}
