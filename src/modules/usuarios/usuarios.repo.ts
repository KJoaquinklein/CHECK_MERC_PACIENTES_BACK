import type { Ejecutor } from '../../db/pool.js';
import { COLUMNAS_USUARIO_PUBLICO } from '../auth/auth.repo.js';
import type { Rol, UsuarioPublico } from '../auth/auth.types.js';
import { escaparLike } from '../comun/sql.js';
import { ORDENES_USUARIO } from './usuarios.schemas.js';

export interface FiltrosUsuarios {
  q?: string;
  rol?: Rol;
  activo?: boolean;
  orden: keyof typeof ORDENES_USUARIO;
  dir: 'asc' | 'desc';
  page: number;
  page_size: number;
}

export async function listarUsuarios(
  db: Ejecutor,
  filtros: FiltrosUsuarios,
): Promise<{ filas: UsuarioPublico[]; total: number }> {
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const agregar = (valor: unknown) => {
    valores.push(valor);
    return `$${valores.length}`;
  };

  if (filtros.q) {
    const patron = agregar(`%${escaparLike(filtros.q.toLowerCase())}%`);
    condiciones.push(
      `(lower(nombre_usuario) LIKE ${patron} ESCAPE '\\' OR lower(nombre_completo) LIKE ${patron} ESCAPE '\\')`,
    );
  }
  if (filtros.rol) condiciones.push(`rol = ${agregar(filtros.rol)}`);
  if (filtros.activo !== undefined) condiciones.push(`activo = ${agregar(filtros.activo)}`);
  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  // La columna y la dirección salen de listas blancas, nunca del texto del usuario
  const columna = ORDENES_USUARIO[filtros.orden];
  const direccion = filtros.dir === 'desc' ? 'DESC' : 'ASC';

  const total = await db.query<{ total: number }>(
    `SELECT count(*) AS total FROM usuario ${donde}`,
    valores,
  );
  const limite = agregar(filtros.page_size);
  const desplazamiento = agregar((filtros.page - 1) * filtros.page_size);
  const filas = await db.query<UsuarioPublico>(
    `SELECT ${COLUMNAS_USUARIO_PUBLICO} FROM usuario ${donde}
     ORDER BY ${columna} ${direccion}, id ${direccion}
     LIMIT ${limite} OFFSET ${desplazamiento}`,
    valores,
  );
  return { filas: filas.rows, total: total.rows[0]!.total };
}

export async function crearUsuario(
  db: Ejecutor,
  datos: { nombre_usuario: string; nombre_completo: string; rol: Rol; password_hash: string },
): Promise<UsuarioPublico> {
  const { rows } = await db.query<UsuarioPublico>(
    `INSERT INTO usuario (nombre_usuario, nombre_completo, rol, password_hash, debe_cambiar_password)
     VALUES ($1, $2, $3, $4, true)
     RETURNING ${COLUMNAS_USUARIO_PUBLICO}`,
    [datos.nombre_usuario, datos.nombre_completo, datos.rol, datos.password_hash],
  );
  return rows[0]!;
}

/** Bloquea las filas de los administradores activos para serializar cambios que los afecten. */
export async function bloquearAdministradoresActivos(db: Ejecutor): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM usuario WHERE rol = 'admin' AND activo ORDER BY id FOR UPDATE",
  );
  return rows.map((fila) => fila.id);
}

export async function bloquearUsuario(
  db: Ejecutor,
  id: number,
): Promise<UsuarioPublico | undefined> {
  const { rows } = await db.query<UsuarioPublico>(
    `SELECT ${COLUMNAS_USUARIO_PUBLICO} FROM usuario WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0];
}

export async function actualizarUsuario(
  db: Ejecutor,
  id: number,
  cambios: { nombre_completo?: string; rol?: Rol; activo?: boolean },
): Promise<UsuarioPublico> {
  const { rows } = await db.query<UsuarioPublico>(
    `UPDATE usuario
     SET nombre_completo = COALESCE($2, nombre_completo),
         rol = COALESCE($3, rol),
         activo = COALESCE($4, activo),
         -- al reactivar a un usuario se limpia el bloqueo por intentos fallidos
         intentos_fallidos = CASE WHEN $4 IS TRUE THEN 0 ELSE intentos_fallidos END,
         bloqueado_hasta = CASE WHEN $4 IS TRUE THEN NULL ELSE bloqueado_hasta END
     WHERE id = $1
     RETURNING ${COLUMNAS_USUARIO_PUBLICO}`,
    [id, cambios.nombre_completo ?? null, cambios.rol ?? null, cambios.activo ?? null],
  );
  return rows[0]!;
}
