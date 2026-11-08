import type pg from 'pg';
import { errores } from '../../errors.js';
import { escaparLike, esViolacionUnicidad, respuestaPaginada } from '../comun/sql.js';

export interface ObraSocial {
  id: number;
  nombre: string;
  activa: boolean;
}

const duplicada = () =>
  errores.conflicto('OBRA_SOCIAL_DUPLICADA', 'Ya existe una obra social con ese nombre');

export async function listar(
  pool: pg.Pool,
  filtros: { q?: string; activa?: boolean; dir: 'asc' | 'desc'; page: number; page_size: number },
) {
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const agregar = (valor: unknown) => {
    valores.push(valor);
    return `$${valores.length}`;
  };
  if (filtros.q) {
    condiciones.push(
      `f_unaccent(lower(nombre)) LIKE '%' || f_unaccent(lower(${agregar(escaparLike(filtros.q))})) || '%' ESCAPE '\\'`,
    );
  }
  if (filtros.activa !== undefined) condiciones.push(`activa = ${agregar(filtros.activa)}`);
  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const direccion = filtros.dir === 'desc' ? 'DESC' : 'ASC';

  const total = await pool.query<{ total: number }>(
    `SELECT count(*) AS total FROM obra_social ${donde}`,
    valores,
  );
  const limite = agregar(filtros.page_size);
  const desplazamiento = agregar((filtros.page - 1) * filtros.page_size);
  const filas = await pool.query<ObraSocial>(
    `SELECT id, nombre, activa FROM obra_social ${donde}
     ORDER BY lower(nombre) ${direccion}, id ${direccion}
     LIMIT ${limite} OFFSET ${desplazamiento}`,
    valores,
  );
  return respuestaPaginada(filas.rows, filtros.page, filtros.page_size, total.rows[0]!.total);
}

export async function crear(pool: pg.Pool, nombre: string): Promise<ObraSocial> {
  try {
    const { rows } = await pool.query<ObraSocial>(
      'INSERT INTO obra_social (nombre) VALUES ($1) RETURNING id, nombre, activa',
      [nombre],
    );
    return rows[0]!;
  } catch (error) {
    if (esViolacionUnicidad(error)) throw duplicada();
    throw error;
  }
}

export async function editar(
  pool: pg.Pool,
  id: number,
  cambios: { nombre?: string; activa?: boolean },
): Promise<ObraSocial> {
  try {
    const { rows } = await pool.query<ObraSocial>(
      `UPDATE obra_social
       SET nombre = COALESCE($2, nombre), activa = COALESCE($3, activa)
       WHERE id = $1
       RETURNING id, nombre, activa`,
      [id, cambios.nombre ?? null, cambios.activa ?? null],
    );
    if (!rows[0]) throw errores.noEncontrado('La obra social no existe');
    return rows[0];
  } catch (error) {
    if (esViolacionUnicidad(error)) throw duplicada();
    throw error;
  }
}

/** Baja lógica: los pacientes que ya la tienen asignada la conservan. */
export function desactivar(pool: pg.Pool, id: number): Promise<ObraSocial> {
  return editar(pool, id, { activa: false });
}
