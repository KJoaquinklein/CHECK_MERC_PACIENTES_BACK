import { z } from 'zod';
import {
  esquemaBooleanoQuery,
  esquemaFecha,
  esquemaId,
  esquemaPaginacion,
  textoOpcional,
} from '../comun/sql.js';

export const TIPOS_ARCHIVO = ['estudio', 'ficha_antigua'] as const;
export type TipoArchivo = (typeof TIPOS_ARCHIVO)[number];

export const MIMES_ARCHIVO = ['application/pdf', 'image/png', 'image/jpeg'] as const;

const esquemaTipo = z.enum(TIPOS_ARCHIVO, { error: 'El tipo debe ser estudio o ficha_antigua' });

/** La fecha de un estudio o ficha no puede ser futura (un día de margen por la zona horaria). */
const esquemaFechaDocumento = esquemaFecha.refine((fecha) => {
  const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return fecha >= '1900-01-01' && fecha <= manana;
}, 'La fecha del documento debe estar entre 1900 y hoy');

/** Campos de texto del formulario multipart; un campo enviado vacío se trata como ausente. */
export const esquemaCamposSubida = z.preprocess(
  (campos) =>
    Object.fromEntries(
      Object.entries(campos as Record<string, string>).filter(([, valor]) => valor.trim() !== ''),
    ),
  z.strictObject({
    id_paciente: esquemaId,
    tipo: esquemaTipo.default('estudio'),
    descripcion: textoOpcional(2000, 'La descripción').optional(),
    fecha_documento: esquemaFechaDocumento.optional(),
    id_consulta: esquemaId.optional(),
  }),
);

/** Solo se editan los metadatos: el binario es inmutable (se sube uno nuevo). */
export const esquemaEditarArchivo = z
  .strictObject({
    descripcion: textoOpcional(2000, 'La descripción'),
    tipo: esquemaTipo,
    fecha_documento: esquemaFechaDocumento.nullable(),
    id_consulta: esquemaId.nullable(),
  })
  .partial()
  .refine((datos) => Object.keys(datos).length > 0, 'Indicá al menos un campo para modificar');

export const ORDENES_ARCHIVO = ['subido_en', 'fecha_documento'] as const;

export const esquemaListarArchivos = z
  .strictObject({
    id_paciente: esquemaId.optional(),
    tipo: esquemaTipo.optional(),
    mime_type: z.enum(MIMES_ARCHIVO, { error: 'Tipo de contenido no admitido' }).optional(),
    desde: esquemaFecha.optional(),
    hasta: esquemaFecha.optional(),
    incluir_eliminados: esquemaBooleanoQuery.default(false),
    orden: z.enum(ORDENES_ARCHIVO).default('subido_en'),
    dir: z.enum(['asc', 'desc']).default('desc'),
    ...esquemaPaginacion(100),
  })
  .refine(
    (datos) => !datos.desde || !datos.hasta || datos.desde <= datos.hasta,
    'desde no puede ser posterior a hasta',
  );

export type CamposSubida = z.infer<typeof esquemaCamposSubida>;
export type EditarArchivo = z.infer<typeof esquemaEditarArchivo>;
export type ListarArchivos = z.infer<typeof esquemaListarArchivos>;
