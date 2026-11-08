import { z } from 'zod';
import { esquemaFecha } from '../comun/sql.js';

const fechaDeReporte = esquemaFecha.refine(
  (fecha) => fecha >= '1900-01-01' && fecha <= '2100-12-31',
  'La fecha debe estar entre 1900 y 2100',
);

const formato = z
  .enum(['json', 'csv'], { error: 'El formato debe ser json o csv' })
  .default('json');

const periodo = {
  desde: fechaDeReporte.optional(),
  hasta: fechaDeReporte.optional(),
  formato,
};

const rangoValido = (datos: { desde?: string; hasta?: string }) =>
  !datos.desde || !datos.hasta || datos.desde <= datos.hasta;
const mensajeRango = 'desde no puede ser posterior a hasta';

/** Reportes sin parámetros propios: solo el formato de salida. */
export const esquemaSoloFormato = z.strictObject({ formato });

/** Series mensuales: rango de fechas opcional (días completos, inclusivos, hora de Córdoba). */
export const esquemaPeriodo = z.strictObject(periodo).refine(rangoValido, mensajeRango);

export const esquemaRankingPacientes = z
  .strictObject({
    ...periodo,
    limit: z.coerce.number({ error: 'limit debe ser un número' }).int().min(1).max(100).default(10),
  })
  .refine(rangoValido, mensajeRango);

export type Formato = z.infer<typeof formato>;
export type Periodo = Pick<z.infer<typeof esquemaPeriodo>, 'desde' | 'hasta'>;
