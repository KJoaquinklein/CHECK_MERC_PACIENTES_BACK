import { createReadStream } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition } from '../src/modules/archivos/archivos.service.js';
import { sanitizarNombre } from '../src/modules/archivos/subida.js';
import {
  StorageObjectNotFound,
  StorageOperationNotSupported,
  type StorageDriver,
} from '../src/storage/driver.js';
import { LocalStorageDriver } from '../src/storage/local.driver.js';
import { PDF } from './utilidades/archivos.js';
import { crearS3DePrueba, S3Falso } from './utilidades/s3-falso.js';

const carpetaTemporal = mkdtempSync(path.join(os.tmpdir(), 'hc-test-storage-'));
afterAll(() => rmSync(carpetaTemporal, { recursive: true, force: true }));

/** El driver S3 recibe un archivo, igual que en producción (el SDK firma el cuerpo leyéndolo). */
function archivoComoStream(contenido: Buffer): Readable {
  const ruta = path.join(carpetaTemporal, `origen-${Math.random()}.bin`);
  writeFileSync(ruta, contenido);
  return createReadStream(ruta);
}

async function leer(stream: Readable): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const parte of stream) partes.push(parte as Buffer);
  return Buffer.concat(partes);
}

/** Pruebas que cualquier driver debe cumplir: el mismo código sirve para local y para S3. */
function contratoDelDriver(nombre: string, obtener: () => StorageDriver, firmaUrls: boolean) {
  describe(`StorageDriver: ${nombre}`, () => {
    const claves: string[] = [];
    const nuevaClave = () => {
      const clave = `estudios/1/${crypto.randomUUID()}.pdf`;
      claves.push(clave);
      return clave;
    };
    afterAll(async () => {
      for (const clave of claves) await obtener().delete(clave);
    });

    it('guarda un objeto y lo devuelve idéntico', async () => {
      const clave = nuevaClave();
      expect(await obtener().exists(clave)).toBe(false);
      await obtener().put(clave, archivoComoStream(PDF), {
        mime: 'application/pdf',
        size: PDF.length,
      });
      expect(await obtener().exists(clave)).toBe(true);
      expect((await leer(await obtener().getStream(clave))).equals(PDF)).toBe(true);
    });

    it('pedir un objeto inexistente lanza StorageObjectNotFound', async () => {
      await expect(obtener().getStream('estudios/1/no-existe.pdf')).rejects.toBeInstanceOf(
        StorageObjectNotFound,
      );
      expect(await obtener().exists('estudios/1/no-existe.pdf')).toBe(false);
    });

    it('delete borra el objeto y repetirlo no falla', async () => {
      const clave = nuevaClave();
      await obtener().put(clave, archivoComoStream(PDF), {
        mime: 'application/pdf',
        size: PDF.length,
      });
      await obtener().delete(clave);
      expect(await obtener().exists(clave)).toBe(false);
      await expect(obtener().delete(clave)).resolves.toBeUndefined();
    });

    it(
      firmaUrls
        ? 'genera una URL firmada de corta duración que sirve el objeto'
        : 'no soporta URLs firmadas',
      async () => {
        const clave = nuevaClave();
        await obtener().put(clave, archivoComoStream(PDF), {
          mime: 'application/pdf',
          size: PDF.length,
        });
        if (!firmaUrls) {
          await expect(obtener().getSignedUrl(clave, 60)).rejects.toBeInstanceOf(
            StorageOperationNotSupported,
          );
          return;
        }
        const url = await obtener().getSignedUrl(clave, 60, {
          contentType: 'application/pdf',
          contentDisposition: 'inline; filename="a.pdf"',
        });
        expect(url).toContain('X-Amz-Signature=');
        expect(url).toContain('X-Amz-Expires=60');
        const respuesta = await fetch(url);
        expect(respuesta.status).toBe(200);
        expect(respuesta.headers.get('content-type')).toBe('application/pdf');
        expect(Buffer.from(await respuesta.arrayBuffer()).equals(PDF)).toBe(true);
      },
    );
  });
}

contratoDelDriver(
  'local',
  (() => {
    const driver = new LocalStorageDriver(path.join(carpetaTemporal, 'local'));
    return () => driver;
  })(),
  false,
);

describe('LocalStorageDriver: seguridad de rutas', () => {
  const driver = new LocalStorageDriver(path.join(carpetaTemporal, 'seguro'));

  it('rechaza claves que salgan de la carpeta base', async () => {
    for (const clave of [
      '../fuera.pdf',
      'estudios/../../fuera.pdf',
      '/etc/passwd',
      'a\\b.pdf',
      '',
      'a\0b',
    ]) {
      await expect(
        driver.put(clave, archivoComoStream(PDF), { mime: 'application/pdf', size: PDF.length }),
      ).rejects.toThrow();
      expect(await driver.exists(clave), JSON.stringify(clave)).toBe(false);
    }
  });
});

describe('StorageDriver: s3 (SDK real de AWS)', () => {
  const falso = new S3Falso();
  let s3: ReturnType<typeof crearS3DePrueba>;

  beforeAll(async () => {
    await falso.iniciar();
    s3 = crearS3DePrueba(falso);
  });
  afterAll(async () => {
    await falso.detener();
  });

  // vitest necesita registrar el contrato durante la colección: se delega en un driver diferido
  const diferido: StorageDriver = {
    put: (...args) => s3.storage.put(...args),
    getStream: (...args) => s3.storage.getStream(...args),
    getSignedUrl: (...args) => s3.storage.getSignedUrl(...args),
    exists: (...args) => s3.storage.exists(...args),
    delete: (...args) => s3.storage.delete(...args),
  };
  contratoDelDriver('s3', () => diferido, true);
});

describe('nombres de archivo', () => {
  it('quita rutas, caracteres de control y respeta el largo máximo', () => {
    expect(sanitizarNombre('../../etc/passwd.pdf', 'pdf')).toBe('passwd.pdf');
    expect(sanitizarNombre('C:\\Users\\ana\\resonancia.pdf', 'pdf')).toBe('resonancia.pdf');
    expect(sanitizarNombre('a\r\nX-Evil: 1\u0000.pdf', 'pdf')).toBe('aX-Evil: 1.pdf');
    expect(sanitizarNombre('   ', 'png')).toBe('archivo.png');
    expect(sanitizarNombre('..', 'png')).toBe('archivo.png');
    expect(sanitizarNombre('', 'jpg')).toBe('archivo.jpg');
    const largo = sanitizarNombre(`${'a'.repeat(400)}.pdf`, 'pdf');
    expect(largo).toHaveLength(255);
    expect(largo.endsWith('.pdf')).toBe(true);
  });

  it('el encabezado Content-Disposition no se puede romper con comillas ni saltos de línea', () => {
    const cabecera = contentDisposition('Resonancia "ñandú" \\ 50%.pdf');
    expect(cabecera).toBe(
      `inline; filename="Resonancia __and__ _ 50_.pdf"; filename*=UTF-8''Resonancia%20%22%C3%B1and%C3%BA%22%20%5C%2050%25.pdf`,
    );
    expect(cabecera).not.toMatch(/[\r\n]/);
    expect(contentDisposition("a'b(c).pdf")).toContain("filename*=UTF-8''a%27b%28c%29.pdf");
  });
});
