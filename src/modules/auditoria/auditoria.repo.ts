import type { Ejecutor } from '../../db/pool.js';
import type { ListarAuditoria } from './auditoria.schemas.js';

const ZONA = 'America/Argentina/Cordoba';

export interface RegistroDeAuditoria {
  id: number;
  fecha: Date;
  usuario: { id: number; nombre_usuario: string; nombre_completo: string } | null;
  accion: string;
  entidad: string | null;
  entidad_id: number | null;
  ip: string | null;
  detalle: Record<string, unknown> | null;
}

const SELECT = `
  SELECT a.id, a.fecha, a.accion, a.entidad, a.entidad_id, a.ip, a.detalle,
         CASE WHEN u.id IS NULL THEN NULL
              ELSE json_build_object('id', u.id, 'nombre_usuario', u.nombre_usuario,
                                     'nombre_completo', u.nombre_completo) END AS usuario
  FROM auditoria a
  LEFT JOIN usuario u ON u.id = a.id_usuario`;

export async function listarAuditoria(
  db: Ejecutor,
  filtros: ListarAuditoria,
): Promise<{ filas: RegistroDeAuditoria[]; total: number }> {
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const agregar = (valor: unknown) => {
    valores.push(valor);
    return `$${valores.length}`;
  };

  // desde/hasta son días completos (inclusivos) en hora de Córdoba
  if (filtros.desde) {
    condiciones.push(
      `a.fecha >= (${agregar(filtros.desde)}::date)::timestamp AT TIME ZONE '${ZONA}'`,
    );
  }
  if (filtros.hasta) {
    condiciones.push(
      `a.fecha < (${agregar(filtros.hasta)}::date + 1)::timestamp AT TIME ZONE '${ZONA}'`,
    );
  }
  if (filtros.id_usuario) condiciones.push(`a.id_usuario = ${agregar(filtros.id_usuario)}`);
  if (filtros.accion) condiciones.push(`a.accion = ${agregar(filtros.accion)}`);
  if (filtros.entidad) condiciones.push(`a.entidad = ${agregar(filtros.entidad)}`);
  if (filtros.entidad_id) condiciones.push(`a.entidad_id = ${agregar(filtros.entidad_id)}`);
  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const total = await db.query<{ total: number }>(
    `SELECT count(*) AS total FROM auditoria a ${donde}`,
    valores,
  );
  const limite = agregar(filtros.page_size);
  const desplazamiento = agregar((filtros.page - 1) * filtros.page_size);
  const filas = await db.query<RegistroDeAuditoria>(
    `${SELECT} ${donde} ORDER BY a.fecha DESC, a.id DESC LIMIT ${limite} OFFSET ${desplazamiento}`,
    valores,
  );
  return { filas: filas.rows, total: total.rows[0]!.total };
}

export async function obtenerRegistro(
  db: Ejecutor,
  id: number,
): Promise<RegistroDeAuditoria | undefined> {
  const { rows } = await db.query<RegistroDeAuditoria>(`${SELECT} WHERE a.id = $1`, [id]);
  return rows[0];
}

/** Acciones que existen en la auditoría, para armar filtros. */
export async function accionesExistentes(db: Ejecutor): Promise<string[]> {
  const { rows } = await db.query<{ accion: string }>(
    'SELECT DISTINCT accion FROM auditoria ORDER BY accion',
  );
  return rows.map((fila) => fila.accion);
}
