import { z } from 'zod';
import { esquemaFecha, esquemaId, esquemaPaginacion } from '../comun/sql.js';

/** Nombres de acción y de entidad: minúsculas, números y guion bajo (nunca texto libre). */
const identificador = z
  .string()
  .regex(/^[a-z0-9_]{1,50}$/, 'Solo se admiten minúsculas, números y guion bajo (hasta 50)');

export const esquemaListarAuditoria = z
  .strictObject({
    desde: esquemaFecha.optional(),
    hasta: esquemaFecha.optional(),
    id_usuario: esquemaId.optional(),
    accion: identificador.optional(),
    entidad: identificador.optional(),
    entidad_id: esquemaId.optional(),
    // La auditoría admite páginas más grandes que el resto (hasta 200)
    ...esquemaPaginacion(200),
  })
  .refine(
    (datos) => !datos.desde || !datos.hasta || datos.desde <= datos.hasta,
    'desde no puede ser posterior a hasta',
  );

export type ListarAuditoria = z.infer<typeof esquemaListarAuditoria>;
