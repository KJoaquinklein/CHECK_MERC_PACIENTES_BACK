import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import { fileTypeFromBuffer } from 'file-type';
import { AppError, errores } from '../../errors.js';

/** Tipos permitidos, detectados por el contenido (magic bytes) y su extensión canónica. */
export const TIPOS_PERMITIDOS = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
} as const;
export type MimePermitido = keyof typeof TIPOS_PERMITIDOS;

export const DIRECTORIO_TEMPORAL = path.join(os.tmpdir(), 'hc-uploads');

/** Cantidad de bytes iniciales que `file-type` necesita para identificar el formato. */
const BYTES_PARA_DETECTAR = 4100;

export interface SubidaRecibida {
  campos: Record<string, string>;
  archivo: {
    rutaTemporal: string;
    nombreOriginal: string;
    bytes: number;
    sha256: string;
    mime: MimePermitido;
    extension: string;
  };
  /** Borra el archivo temporal. Hay que llamarlo siempre al terminar. */
  limpiar: () => Promise<void>;
}

const tipoNoPermitido = () =>
  new AppError(
    415,
    'TIPO_NO_PERMITIDO',
    'Solo se admiten archivos PDF, PNG o JPEG. Se verifica el contenido del archivo, no su nombre.',
  );

/**
 * Mientras el archivo pasa: cuenta los bytes, calcula el sha256 y, apenas hay bytes suficientes,
 * identifica el formato real. Si no es uno permitido corta la subida de inmediato.
 */
class Inspector extends Transform {
  bytes = 0;
  mime: MimePermitido | undefined;
  private readonly hash = createHash('sha256');
  private cabecera: Buffer[] = [];
  private largoCabecera = 0;
  private verificado = false;

  override _transform(chunk: Buffer, _codificacion: BufferEncoding, listo: TransformCallback) {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    if (this.verificado) return listo(null, chunk);

    this.cabecera.push(chunk);
    this.largoCabecera += chunk.length;
    if (this.largoCabecera < BYTES_PARA_DETECTAR) return listo(null, chunk);
    this.verificar().then(
      () => listo(null, chunk),
      (error: unknown) => listo(error as Error),
    );
  }

  override _flush(listo: TransformCallback) {
    // Un archivo vacío no se analiza: lo rechaza quien recibe la subida con un mensaje propio
    if (this.verificado || this.bytes === 0) return listo();
    this.verificar().then(
      () => listo(),
      (error: unknown) => listo(error as Error),
    );
  }

  get sha256(): string {
    return this.hash.copy().digest('hex');
  }

  private async verificar(): Promise<void> {
    this.verificado = true;
    const detectado = await fileTypeFromBuffer(Buffer.concat(this.cabecera));
    this.cabecera = [];
    if (!detectado || !(detectado.mime in TIPOS_PERMITIDOS)) throw tipoNoPermitido();
    this.mime = detectado.mime as MimePermitido;
  }
}

/**
 * Recibe un formulario multipart con un único archivo (campo `file`) y sus campos de texto.
 * El archivo se guarda en una carpeta temporal mientras se valida; el límite de tamaño corta la
 * transferencia apenas se supera. Como los campos pueden llegar después del archivo, la
 * validación contra la base y la copia al almacenamiento definitivo se hacen luego.
 */
export function recibirSubida(
  req: IncomingMessage,
  opciones: { maxBytes: number; directorio?: string },
): Promise<SubidaRecibida> {
  const directorio = opciones.directorio ?? DIRECTORIO_TEMPORAL;

  return new Promise((resolver, rechazar) => {
    let analizador: busboy.Busboy;
    try {
      analizador = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: {
          fileSize: opciones.maxBytes,
          files: 1,
          fields: 10,
          fieldSize: 10_000,
          parts: 12,
          headerPairs: 50,
        },
      });
    } catch {
      rechazar(errores.validacion('Se esperaba un formulario multipart/form-data'));
      return;
    }

    const campos: Record<string, string> = {};
    let rutaTemporal: string | undefined;
    let nombreOriginal = '';
    let inspector: Inspector | undefined;
    let escritura: Promise<void> | undefined;
    let terminado = false;
    const abortar = new AbortController();

    const limpiar = async () => {
      if (rutaTemporal) await rm(rutaTemporal, { force: true });
    };
    const fallar = (error: unknown) => {
      if (terminado) return;
      terminado = true;
      req.unpipe(analizador);
      // Primero se cierra la escritura y recién después se borra el temporal
      abortar.abort();
      void Promise.allSettled([escritura])
        .then(limpiar)
        .finally(() => rechazar(error));
    };

    req.on('error', fallar);
    req.on('close', () => {
      if (!req.complete) fallar(errores.validacion('La subida se interrumpió antes de terminar'));
    });
    analizador.on('error', fallar);
    analizador.on('filesLimit', () =>
      fallar(errores.validacion('Se admite un solo archivo por vez')),
    );
    analizador.on('fieldsLimit', () =>
      fallar(errores.validacion('El formulario tiene demasiados campos')),
    );
    analizador.on('partsLimit', () =>
      fallar(errores.validacion('El formulario tiene demasiadas partes')),
    );

    analizador.on('field', (nombre, valor, info) => {
      if (info.nameTruncated || info.valueTruncated) {
        fallar(errores.validacion(`El campo "${nombre}" es demasiado largo`));
        return;
      }
      if (nombre in campos) {
        fallar(errores.validacion(`El campo "${nombre}" está repetido`));
        return;
      }
      campos[nombre] = valor;
    });

    analizador.on('file', (nombre, flujo, info) => {
      if (nombre !== 'file' || rutaTemporal) {
        flujo.resume();
        fallar(errores.validacion('El archivo debe enviarse una sola vez, en el campo "file"'));
        return;
      }
      nombreOriginal = info.filename ?? '';
      rutaTemporal = path.join(directorio, randomUUID());
      const destino = rutaTemporal;
      inspector = new Inspector();

      flujo.on('limit', () => {
        flujo.resume();
        fallar(
          new AppError(
            413,
            'ARCHIVO_DEMASIADO_GRANDE',
            `El archivo supera el tamaño máximo de ${Number((opciones.maxBytes / 1024 / 1024).toFixed(2))} MB`,
          ),
        );
      });
      escritura = mkdir(directorio, { recursive: true }).then(() =>
        pipeline(flujo, inspector!, createWriteStream(destino, { flags: 'wx', mode: 0o600 }), {
          signal: abortar.signal,
        }),
      );
      escritura.catch(fallar);
    });

    analizador.on('close', () => {
      if (terminado) return;
      void (async () => {
        if (!escritura || !inspector || !rutaTemporal) {
          throw errores.validacion('Falta el archivo: enviarlo en el campo "file"');
        }
        await escritura;
        if (inspector.bytes === 0) throw errores.validacion('El archivo está vacío');
        if (terminado) return;
        terminado = true;
        resolver({
          campos,
          archivo: {
            rutaTemporal,
            nombreOriginal,
            bytes: inspector.bytes,
            sha256: inspector.sha256,
            mime: inspector.mime!,
            extension: TIPOS_PERMITIDOS[inspector.mime!],
          },
          limpiar,
        });
      })().catch(fallar);
    });

    req.pipe(analizador);
  });
}

// eslint-disable-next-line no-control-regex
const CARACTERES_DE_CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Nombre apto para mostrar y para el encabezado de descarga: sin rutas, sin caracteres de
 * control y de hasta 255 caracteres (conservando la extensión).
 */
export function sanitizarNombre(nombre: string, extension: string): string {
  const base = nombre.split(/[\\/]/).pop() ?? '';
  let limpio = base.replace(CARACTERES_DE_CONTROL, '').replace(/\s+/g, ' ').trim();
  if (limpio.length > 255) {
    const punto = limpio.lastIndexOf('.');
    const ext = punto > 0 && limpio.length - punto <= 10 ? limpio.slice(punto) : '';
    limpio = limpio.slice(0, 255 - ext.length) + ext;
  }
  return limpio && limpio !== '.' && limpio !== '..' ? limpio : `archivo.${extension}`;
}
