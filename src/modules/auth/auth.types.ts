export type Rol = 'admin' | 'profesional';

/** Datos del usuario que viajan en `req.usuario` (nunca incluyen hashes). */
export interface UsuarioSesion {
  id: number;
  nombre_usuario: string;
  nombre_completo: string;
  rol: Rol;
  debe_cambiar_password: boolean;
}

/** Usuario tal como se devuelve por la API. */
export interface UsuarioPublico extends UsuarioSesion {
  activo: boolean;
  bloqueado_hasta: Date | null;
  ultimo_login: Date | null;
  creado_en: Date;
}
