import { z } from 'zod';
import { esquemaBooleanoQuery, esquemaDireccion, esquemaPaginacion } from '../comun/sql.js';
import { esquemaNombreUsuario, esquemaPasswordNueva } from '../auth/auth.schemas.js';

const esquemaRol = z.enum(['admin', 'profesional'], {
  error: 'El rol debe ser admin o profesional',
});
const esquemaNombreCompleto = z
  .string({ error: 'El nombre completo es obligatorio' })
  .trim()
  .min(1, 'El nombre completo no puede estar vacío')
  .max(200, 'El nombre completo no puede superar los 200 caracteres');

export const esquemaCrearUsuario = z.strictObject({
  nombre_usuario: esquemaNombreUsuario,
  nombre_completo: esquemaNombreCompleto,
  rol: esquemaRol,
  password_temporal: esquemaPasswordNueva,
});

export const esquemaEditarUsuario = z
  .strictObject({
    nombre_completo: esquemaNombreCompleto,
    rol: esquemaRol,
    activo: z.boolean({ error: 'activo debe ser verdadero o falso' }),
  })
  .partial()
  .refine((datos) => Object.keys(datos).length > 0, 'Indicá al menos un campo para modificar');

export const esquemaResetPassword = z.strictObject({ password_temporal: esquemaPasswordNueva });

export const ORDENES_USUARIO = {
  nombre_usuario: 'nombre_usuario',
  nombre_completo: 'nombre_completo',
  creado_en: 'creado_en',
} as const;

export const esquemaListarUsuarios = z.strictObject({
  q: z.string().trim().max(100).optional(),
  rol: esquemaRol.optional(),
  activo: esquemaBooleanoQuery.optional(),
  orden: z
    .enum(Object.keys(ORDENES_USUARIO) as [keyof typeof ORDENES_USUARIO])
    .default('nombre_completo'),
  dir: esquemaDireccion,
  ...esquemaPaginacion(100),
});
