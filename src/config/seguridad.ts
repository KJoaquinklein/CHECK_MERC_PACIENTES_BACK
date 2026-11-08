/** Parámetros de seguridad de sesiones y contraseñas (sección 7.3 del plan). */
export const SEGURIDAD = {
  SESION_DURACION_HORAS: 12,
  // 120 y no 60 porque las consultas pueden ser largas. El frontend renueva la sesión mientras
  // hay actividad en pantalla (ver `useSesionActiva`), así que esto es inactividad real.
  SESION_INACTIVIDAD_MINUTOS: 120,
  LOGIN_MAX_INTENTOS: 5,
  LOGIN_BLOQUEO_MINUTOS: 15,
  LOGIN_VENTANA_MS: 15 * 60 * 1000,
  PASSWORD_MIN: 10,
  /** Tope para que argon2 no se use como vector de agotamiento de recursos. */
  PASSWORD_MAX: 128,
} as const;

export const COOKIE_SESION = 'sid';
