import { z } from 'zod';
import { esquemaBooleanoQuery, esquemaDireccion, esquemaPaginacion } from '../comun/sql.js';

const esquemaNombre = z
  .string({ error: 'El nombre es obligatorio' })
  .trim()
  .min(1, 'El nombre no puede estar vacío')
  .max(120, 'El nombre no puede superar los 120 caracteres');

export const esquemaCrearObraSocial = z.strictObject({ nombre: esquemaNombre });

export const esquemaEditarObraSocial = z
  .strictObject({
    nombre: esquemaNombre,
    activa: z.boolean({ error: 'activa debe ser verdadero o falso' }),
  })
  .partial()
  .refine((datos) => Object.keys(datos).length > 0, 'Indicá al menos un campo para modificar');

export const esquemaListarObrasSociales = z.strictObject({
  q: z.string().trim().max(100).optional(),
  activa: esquemaBooleanoQuery.optional(),
  dir: esquemaDireccion,
  ...esquemaPaginacion(100),
});
