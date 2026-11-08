import type { Ejecutor } from '../../db/pool.js';
import type { Rol, UsuarioPublico, UsuarioSesion } from './auth.types.js';

export const COLUMNAS_USUARIO_PUBLICO = `id, nombre_usuario, nombre_completo, rol, activo,
  debe_cambiar_password, bloqueado_hasta, ultimo_login, creado_en`;

export interface UsuarioConCredenciales {
  id: number;
  nombre_usuario: string;
  nombre_completo: string;
  rol: Rol;
  activo: boolean;
  debe_cambiar_password: boolean;
  password_hash: string;
  /** Calculado con el reloj de la base, no el de la aplicación. */
  bloqueado: boolean;
}

export async function buscarParaLogin(
  db: Ejecutor,
  nombreUsuario: string,
): Promise<UsuarioConCredenciales | undefined> {
  const { rows } = await db.query<UsuarioConCredenciales>(
    `SELECT id, nombre_usuario, nombre_completo, rol, activo, debe_cambiar_password, password_hash,
            (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > now()) AS bloqueado
     FROM usuario WHERE nombre_usuario = $1`,
    [nombreUsuario],
  );
  return rows[0];
}

export async function buscarConCredencialesPorId(
  db: Ejecutor,
  id: number,
): Promise<UsuarioConCredenciales | undefined> {
  const { rows } = await db.query<UsuarioConCredenciales>(
    `SELECT id, nombre_usuario, nombre_completo, rol, activo, debe_cambiar_password, password_hash,
            (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > now()) AS bloqueado
     FROM usuario WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/**
 * Suma un intento fallido y bloquea al llegar al máximo. Si un bloqueo anterior ya venció, el
 * conteo vuelve a empezar. No toca a un usuario que ya está bloqueado (evita que un atacante
 * extienda el bloqueo indefinidamente).
 */
export async function registrarIntentoFallido(
  db: Ejecutor,
  idUsuario: number,
  maxIntentos: number,
  bloqueoMinutos: number,
): Promise<{ bloqueado: boolean }> {
  const { rows } = await db.query<{ bloqueado: boolean }>(
    `UPDATE usuario u
     SET intentos_fallidos = n.intentos,
         bloqueado_hasta = CASE WHEN n.intentos >= $2
                                THEN now() + make_interval(mins => $3) ELSE NULL END
     FROM (
       SELECT id, CASE WHEN bloqueado_hasta IS NOT NULL AND bloqueado_hasta <= now()
                       THEN 1 ELSE intentos_fallidos + 1 END AS intentos
       FROM usuario
       WHERE id = $1 AND (bloqueado_hasta IS NULL OR bloqueado_hasta <= now())
       FOR UPDATE
     ) n
     WHERE u.id = n.id
     RETURNING (u.bloqueado_hasta IS NOT NULL) AS bloqueado`,
    [idUsuario, maxIntentos, bloqueoMinutos],
  );
  return { bloqueado: rows[0]?.bloqueado ?? false };
}

export async function registrarLoginExitoso(db: Ejecutor, idUsuario: number): Promise<void> {
  await db.query(
    `UPDATE usuario
     SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_login = now()
     WHERE id = $1`,
    [idUsuario],
  );
}

export async function crearSesion(
  db: Ejecutor,
  datos: {
    idUsuario: number;
    tokenHash: string;
    duracionHoras: number;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO sesion (id_usuario, token_hash, expira_en, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [datos.idUsuario, datos.tokenHash, datos.duracionHoras, datos.ip, datos.userAgent],
  );
}

/** Borra las sesiones vencidas o revocadas del usuario (mantenimiento al iniciar sesión). */
export async function limpiarSesionesInactivas(db: Ejecutor, idUsuario: number): Promise<void> {
  await db.query('DELETE FROM sesion WHERE id_usuario = $1 AND (revocada OR expira_en < now())', [
    idUsuario,
  ]);
}

/**
 * Busca la sesión vigente (no revocada, no vencida, con uso reciente, de un usuario activo) y
 * renueva `ultimo_uso` en la misma consulta.
 */
export async function tocarSesionActiva(
  db: Ejecutor,
  tokenHash: string,
  inactividadMinutos: number,
): Promise<{ sesionId: number; usuario: UsuarioSesion } | undefined> {
  const { rows } = await db.query<UsuarioSesion & { sesion_id: number }>(
    `UPDATE sesion s SET ultimo_uso = now()
     FROM usuario u
     WHERE s.token_hash = $1
       AND u.id = s.id_usuario
       AND u.activo
       AND NOT s.revocada
       AND s.expira_en > now()
       AND s.ultimo_uso > now() - make_interval(mins => $2)
     RETURNING s.id AS sesion_id, u.id, u.nombre_usuario, u.nombre_completo, u.rol,
               u.debe_cambiar_password`,
    [tokenHash, inactividadMinutos],
  );
  const fila = rows[0];
  if (!fila) return undefined;
  const { sesion_id, ...usuario } = fila;
  return { sesionId: sesion_id, usuario };
}

export async function revocarSesion(db: Ejecutor, sesionId: number): Promise<void> {
  await db.query('UPDATE sesion SET revocada = true WHERE id = $1', [sesionId]);
}

/** Revoca todas las sesiones de un usuario, salvo opcionalmente una. */
export async function revocarSesionesDeUsuario(
  db: Ejecutor,
  idUsuario: number,
  exceptoSesionId?: number,
): Promise<void> {
  await db.query(
    'UPDATE sesion SET revocada = true WHERE id_usuario = $1 AND NOT revocada AND id <> $2',
    [idUsuario, exceptoSesionId ?? 0],
  );
}

export async function actualizarPassword(
  db: Ejecutor,
  idUsuario: number,
  passwordHash: string,
  debeCambiar: boolean,
): Promise<void> {
  await db.query(
    `UPDATE usuario
     SET password_hash = $2, debe_cambiar_password = $3, intentos_fallidos = 0, bloqueado_hasta = NULL
     WHERE id = $1`,
    [idUsuario, passwordHash, debeCambiar],
  );
}

export async function obtenerUsuarioPublico(
  db: Ejecutor,
  id: number,
): Promise<UsuarioPublico | undefined> {
  const { rows } = await db.query<UsuarioPublico>(
    `SELECT ${COLUMNAS_USUARIO_PUBLICO} FROM usuario WHERE id = $1`,
    [id],
  );
  return rows[0];
}
