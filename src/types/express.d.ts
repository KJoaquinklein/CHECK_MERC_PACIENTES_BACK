import type { UsuarioSesion } from '../modules/auth/auth.types.js';

declare global {
  namespace Express {
    interface Request {
      /** Usuario de la sesión actual; solo existe después del middleware `autenticar`. */
      usuario?: UsuarioSesion;
      /** Id de la fila de `sesion` de la petición actual. */
      sesionId?: number;
    }
  }
}
