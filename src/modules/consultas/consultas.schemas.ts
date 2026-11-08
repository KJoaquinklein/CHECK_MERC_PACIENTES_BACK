import { z } from 'zod';
import { esquemaBooleanoQuery, esquemaFecha, esquemaId, esquemaPaginacion } from '../comun/sql.js';

export const MAX_CARACTERES_CONTENIDO = 100_000;
const MARGEN_FUTURO_MS = 5 * 60_000;

const esquemaContenido = z
  .string({ error: 'El contenido es obligatorio' })
  .trim()
  .min(1, 'El contenido no puede estar vacío')
  .max(
    MAX_CARACTERES_CONTENIDO,
    `El contenido no puede superar los ${MAX_CARACTERES_CONTENIDO} caracteres`,
  );

/**
 * Fecha clínica: un instante ISO 8601 con zona horaria. No puede ser futura (unos minutos de
 * margen por diferencias de reloj) porque agenda y turnos están fuera de alcance.
 */
const esquemaFechaConsulta = z.iso
  .datetime({
    offset: true,
    error: 'La fecha debe ser ISO 8601 con zona horaria (ej. 2024-05-10T15:30:00-03:00)',
  })
  .refine((fecha) => {
    const instante = Date.parse(fecha);
    return (
      instante >= Date.parse('1900-01-01T00:00:00Z') && instante <= Date.now() + MARGEN_FUTURO_MS
    );
  }, 'La fecha de la consulta debe estar entre 1900 y el momento actual');

export const esquemaCrearConsulta = z.strictObject({
  id_paciente: esquemaId,
  fecha_consulta: esquemaFechaConsulta.optional(),
  contenido: esquemaContenido,
});

export const esquemaNuevaEdicion = z.strictObject({
  contenido: esquemaContenido,
  version_base: z
    .number({ error: 'version_base debe ser un número' })
    .int('version_base debe ser un entero')
    .min(0, 'version_base no puede ser negativa'),
  motivo_edicion: z
    .string({ error: 'El motivo debe ser texto' })
    .trim()
    .max(500, 'El motivo no puede superar los 500 caracteres')
    .transform((valor) => (valor === '' ? null : valor))
    .nullable()
    .optional(),
});

export const esquemaCambiarFecha = z.strictObject({ fecha_consulta: esquemaFechaConsulta });

export const esquemaParamsVersion = z.strictObject({
  id: esquemaId,
  version: z.coerce
    .number({ error: 'La versión debe ser un número' })
    .int('La versión debe ser un entero')
    .min(0)
    .max(Number.MAX_SAFE_INTEGER),
});

export const esquemaListarConsultas = z
  .strictObject({
    id_paciente: esquemaId.optional(),
    desde: esquemaFecha.optional(),
    hasta: esquemaFecha.optional(),
    q: z.string().trim().max(200).optional(),
    editadas: esquemaBooleanoQuery.optional(),
    incluir_anuladas: esquemaBooleanoQuery.default(false),
    orden: z.enum(['fecha_consulta']).default('fecha_consulta'),
    dir: z.enum(['asc', 'desc']).default('desc'),
    ...esquemaPaginacion(100),
  })
  .refine(
    (datos) => !datos.desde || !datos.hasta || datos.desde <= datos.hasta,
    'desde no puede ser posterior a hasta',
  );

export type ListarConsultas = z.infer<typeof esquemaListarConsultas>;
