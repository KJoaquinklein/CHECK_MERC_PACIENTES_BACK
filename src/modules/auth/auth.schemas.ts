import { z } from 'zod';
import { SEGURIDAD } from '../../config/seguridad.js';

/** Contraseña nueva: mínimo 10 caracteres (sección 7.3); el máximo evita abusar de argon2. */
export const esquemaPasswordNueva = z
  .string({ error: 'La contraseña es obligatoria' })
  .min(
    SEGURIDAD.PASSWORD_MIN,
    `La contraseña debe tener al menos ${SEGURIDAD.PASSWORD_MIN} caracteres`,
  )
  .max(
    SEGURIDAD.PASSWORD_MAX,
    `La contraseña no puede superar ${SEGURIDAD.PASSWORD_MAX} caracteres`,
  );

/** Los nombres de usuario se guardan en minúsculas para que no haya duplicados por mayúsculas. */
export const esquemaNombreUsuario = z
  .string({ error: 'El nombre de usuario es obligatorio' })
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9._-]{3,50}$/,
    'El nombre de usuario debe tener entre 3 y 50 caracteres: letras, números, punto, guion o guion bajo',
  );

export const esquemaLogin = z.strictObject({
  nombre_usuario: z
    .string({ error: 'El nombre de usuario es obligatorio' })
    .trim()
    .toLowerCase()
    .min(1)
    .max(100),
  // Sin reglas de formato: al iniciar sesión solo se compara con el hash
  password: z.string({ error: 'La contraseña es obligatoria' }).min(1).max(SEGURIDAD.PASSWORD_MAX),
});

export const esquemaCambiarPassword = z.strictObject({
  actual: z
    .string({ error: 'La contraseña actual es obligatoria' })
    .min(1)
    .max(SEGURIDAD.PASSWORD_MAX),
  nueva: esquemaPasswordNueva,
});
