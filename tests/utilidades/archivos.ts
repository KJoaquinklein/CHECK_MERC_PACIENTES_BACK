import { readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { DIRECTORIO_TEMPORAL } from '../../src/modules/archivos/subida.js';
import { ENCABEZADO_AJAX } from './app.js';

// --- contenidos mínimos pero reales: lo que importa son los primeros bytes (magic bytes) ---
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(
    '0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0005fe02fea7d6c5ae0000000049454e44ae426082',
    'hex',
  ),
]);
export const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'latin1'),
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]),
]);
export const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
/** Ejecutable de Windows (cabecera MZ): lo que se quiere frenar aunque se llame .pdf */
export const EXE = Buffer.concat([
  Buffer.from('MZ'),
  Buffer.alloc(62, 0),
  Buffer.from([0x80, 0, 0, 0]),
  Buffer.alloc(200, 1),
]);
export const TEXTO = Buffer.from('Esto es solo texto plano, no un PDF.\n'.repeat(200));
export const GIF = Buffer.from(
  'GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;',
  'latin1',
);
export const HTML_COMO_PNG = Buffer.from('<html><script>alert(1)</script></html>'.repeat(300));

export interface Adjunto {
  contenido: Buffer;
  nombre: string;
  /** Content-Type que declara el cliente (el servidor debe ignorarlo). */
  mime?: string;
}

/**
 * Sube un formulario multipart con el cliente de supertest.
 * `campos` se envían antes del archivo; `adjunto: null` omite el archivo.
 */
export function subirArchivo(
  app: Parameters<typeof request>[0],
  cookie: string | undefined,
  campos: Record<string, string | number>,
  adjunto: Adjunto | null,
  nombreCampo = 'file',
) {
  const peticion = request(app).post('/archivos').set(ENCABEZADO_AJAX);
  if (cookie) peticion.set('Cookie', cookie);
  for (const [nombre, valor] of Object.entries(campos)) peticion.field(nombre, String(valor));
  if (adjunto) {
    peticion.attach(nombreCampo, adjunto.contenido, {
      filename: adjunto.nombre,
      contentType: adjunto.mime ?? 'application/octet-stream',
    });
  }
  return peticion;
}

/** Cuenta los archivos que hay (en cualquier subcarpeta) dentro de una carpeta. */
export function contarArchivosEn(directorio: string): number {
  try {
    return readdirSync(directorio, { withFileTypes: true }).reduce(
      (total, entrada) =>
        total + (entrada.isDirectory() ? contarArchivosEn(path.join(directorio, entrada.name)) : 1),
      0,
    );
  } catch {
    return 0;
  }
}

/** Archivos temporales de subidas que quedaron sin borrar. */
export const temporalesPendientes = () => contarArchivosEn(DIRECTORIO_TEMPORAL);
