import type { Ejecutor } from '../../db/pool.js';
import { escaparLike } from '../comun/sql.js';
import type { FiltrosPacientes, ListarPacientes } from './pacientes.schemas.js';

const ZONA = 'America/Argentina/Cordoba';

export interface Paciente {
  id: number;
  nombre_completo: string;
  dni: string | null;
  fecha_nacimiento: string | null;
  telefono: string | null;
  email: string | null;
  domicilio: string | null;
  id_obra_social: number | null;
  obra_social: { id: number; nombre: string; activa: boolean } | null;
  nro_afiliado: string | null;
  observaciones: string | null;
  activo: boolean;
  creado_en: Date;
  actualizado_en: Date;
}

/** Campos que se pueden escribir en `paciente` (lista blanca para armar el INSERT/UPDATE). */
export const CAMPOS_EDITABLES = [
  'nombre_completo',
  'dni',
  'fecha_nacimiento',
  'telefono',
  'email',
  'domicilio',
  'id_obra_social',
  'nro_afiliado',
  'observaciones',
] as const;
export type CampoEditable = (typeof CAMPOS_EDITABLES)[number];
export type DatosPaciente = Partial<Record<CampoEditable, string | number | null>>;

const SELECT_FICHA = `
  SELECT p.id, p.nombre_completo, p.dni, p.fecha_nacimiento, p.telefono, p.email, p.domicilio,
         p.id_obra_social, p.nro_afiliado, p.observaciones, p.activo, p.creado_en,
         p.actualizado_en,
         CASE WHEN os.id IS NULL THEN NULL
              ELSE json_build_object('id', os.id, 'nombre', os.nombre, 'activa', os.activa)
         END AS obra_social
  FROM paciente p
  LEFT JOIN obra_social os ON os.id = p.id_obra_social`;

export async function obtenerPaciente(
  db: Ejecutor,
  id: number,
  bloquear = false,
): Promise<Paciente | undefined> {
  // FOR UPDATE no se puede combinar con el LEFT JOIN: se bloquea solo la fila de paciente
  if (bloquear) await db.query('SELECT 1 FROM paciente WHERE id = $1 FOR UPDATE', [id]);
  const { rows } = await db.query<Paciente>(`${SELECT_FICHA} WHERE p.id = $1`, [id]);
  return rows[0];
}

export async function resumenDePaciente(
  db: Ejecutor,
  id: number,
): Promise<{ total_consultas: number; ultima_consulta: Date | null; total_archivos: number }> {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM consulta WHERE id_paciente = $1 AND NOT anulada) AS total_consultas,
       (SELECT max(fecha_consulta) FROM consulta WHERE id_paciente = $1 AND NOT anulada)
         AS ultima_consulta,
       (SELECT count(*) FROM paciente_archivo WHERE id_paciente = $1 AND NOT eliminado)
         AS total_archivos`,
    [id],
  );
  return rows[0];
}

export async function estadoObraSocial(
  db: Ejecutor,
  id: number,
): Promise<{ activa: boolean } | undefined> {
  const { rows } = await db.query<{ activa: boolean }>(
    'SELECT activa FROM obra_social WHERE id = $1',
    [id],
  );
  return rows[0];
}

export async function insertarPaciente(db: Ejecutor, datos: DatosPaciente): Promise<number> {
  const columnas = CAMPOS_EDITABLES.filter((campo) => datos[campo] !== undefined);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO paciente (${columnas.join(', ')})
     VALUES (${columnas.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    columnas.map((campo) => datos[campo]),
  );
  return rows[0]!.id;
}

export async function actualizarPaciente(
  db: Ejecutor,
  id: number,
  datos: DatosPaciente,
): Promise<void> {
  const columnas = CAMPOS_EDITABLES.filter((campo) => datos[campo] !== undefined);
  const asignaciones = columnas.map((campo, i) => `${campo} = $${i + 2}`);
  await db.query(
    `UPDATE paciente SET ${[...asignaciones, 'actualizado_en = now()'].join(', ')} WHERE id = $1`,
    [id, ...columnas.map((campo) => datos[campo])],
  );
}

export async function cambiarEstado(db: Ejecutor, id: number, activo: boolean): Promise<void> {
  await db.query('UPDATE paciente SET activo = $2, actualizado_en = now() WHERE id = $1', [
    id,
    activo,
  ]);
}

/**
 * WHERE compartido por el listado y el conteo. Los valores del usuario siempre viajan como
 * parámetros.
 */
function construirFiltros(filtros: FiltrosPacientes) {
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const agregar = (valor: unknown) => {
    valores.push(valor);
    return `$${valores.length}`;
  };

  if (filtros.activo !== 'todos')
    condiciones.push(`p.activo = ${agregar(filtros.activo === 'true')}`);
  if (filtros.id_obra_social)
    condiciones.push(`p.id_obra_social = ${agregar(filtros.id_obra_social)}`);
  if (filtros.creado_desde) {
    condiciones.push(
      `p.creado_en >= (${agregar(filtros.creado_desde)}::date)::timestamp AT TIME ZONE '${ZONA}'`,
    );
  }
  if (filtros.creado_hasta) {
    condiciones.push(
      `p.creado_en < (${agregar(filtros.creado_hasta)}::date + 1)::timestamp AT TIME ZONE '${ZONA}'`,
    );
  }
  for (const palabra of palabrasDeBusqueda(filtros.q)) {
    condiciones.push(
      `p.busqueda LIKE '%' || f_unaccent(lower(${agregar(escaparLike(palabra))})) || '%' ESCAPE '\\'`,
    );
  }
  return {
    donde: condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '',
    valores,
    agregar,
  };
}

/**
 * Separa el texto buscado en palabras (todas deben aparecer, en cualquier orden). Un DNI escrito
 * con puntos ("30.123.456") se normaliza a dígitos, como se guarda.
 */
function palabrasDeBusqueda(texto: string | undefined): string[] {
  if (!texto) return [];
  return texto
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
    .map((palabra) => (/^[\d.]+$/.test(palabra) ? palabra.replace(/\./g, '') : palabra))
    .filter(Boolean);
}

const ORDEN_SQL: Record<ListarPacientes['orden'], string> = {
  nombre: 'lower(p.nombre_completo)',
  dni: 'p.dni',
  creado_en: 'p.creado_en',
  ultima_consulta: 'u.ultima_consulta',
};

export interface PacienteDeLista {
  id: number;
  nombre_completo: string;
  dni: string | null;
  fecha_nacimiento: string | null;
  telefono: string | null;
  email: string | null;
  nro_afiliado: string | null;
  activo: boolean;
  creado_en: Date;
  obra_social: { id: number; nombre: string } | null;
  ultima_consulta: Date | null;
  total_consultas: number;
}

export async function listarPacientes(
  db: Ejecutor,
  filtros: ListarPacientes,
): Promise<{ filas: PacienteDeLista[]; total: number }> {
  const { donde, valores, agregar } = construirFiltros(filtros);

  const total = await db.query<{ total: number }>(
    `SELECT count(*) AS total FROM paciente p ${donde}`,
    valores,
  );

  // La columna y la dirección salen de listas blancas, nunca del texto del usuario
  const columna = ORDEN_SQL[filtros.orden];
  const direccion = filtros.dir === 'desc' ? 'DESC' : 'ASC';
  const limite = agregar(filtros.page_size);
  const desplazamiento = agregar((filtros.page - 1) * filtros.page_size);
  const filas = await db.query<PacienteDeLista>(
    `SELECT p.id, p.nombre_completo, p.dni, p.fecha_nacimiento, p.telefono, p.email,
            p.nro_afiliado, p.activo, p.creado_en,
            CASE WHEN os.id IS NULL THEN NULL
                 ELSE json_build_object('id', os.id, 'nombre', os.nombre) END AS obra_social,
            u.ultima_consulta, u.total_consultas
     FROM paciente p
     LEFT JOIN obra_social os ON os.id = p.id_obra_social
     LEFT JOIN LATERAL (
       SELECT max(c.fecha_consulta) AS ultima_consulta, count(*) AS total_consultas
       FROM consulta c WHERE c.id_paciente = p.id AND NOT c.anulada
     ) u ON true
     ${donde}
     ORDER BY ${columna} ${direccion} NULLS LAST, p.id ${direccion}
     LIMIT ${limite} OFFSET ${desplazamiento}`,
    valores,
  );
  return { filas: filas.rows, total: total.rows[0]!.total };
}

export async function contarPacientes(db: Ejecutor, filtros: FiltrosPacientes): Promise<number> {
  const { donde, valores } = construirFiltros(filtros);
  const { rows } = await db.query<{ total: number }>(
    `SELECT count(*) AS total FROM paciente p ${donde}`,
    valores,
  );
  return rows[0]!.total;
}

export interface ResumenPacientes {
  total: number;
  activos: number;
  inactivos: number;
  nuevos_hoy: number;
  nuevos_semana: number;
  nuevos_mes: number;
  sin_dni: number;
  sin_obra_social: number;
  por_obra_social: { id_obra_social: number; nombre: string; cantidad: number }[];
}

/** Hoy, semana (desde el lunes) y mes calendario, en hora de Córdoba. */
export async function resumenDePacientes(db: Ejecutor): Promise<ResumenPacientes> {
  const { rows } = await db.query<Omit<ResumenPacientes, 'por_obra_social'>>(
    `WITH limites AS (
       SELECT date_trunc('day', now() AT TIME ZONE '${ZONA}') AT TIME ZONE '${ZONA}' AS hoy,
              date_trunc('week', now() AT TIME ZONE '${ZONA}') AT TIME ZONE '${ZONA}' AS semana,
              date_trunc('month', now() AT TIME ZONE '${ZONA}') AT TIME ZONE '${ZONA}' AS mes
     )
     SELECT count(*) AS total,
            count(*) FILTER (WHERE p.activo) AS activos,
            count(*) FILTER (WHERE NOT p.activo) AS inactivos,
            count(*) FILTER (WHERE p.creado_en >= l.hoy) AS nuevos_hoy,
            count(*) FILTER (WHERE p.creado_en >= l.semana) AS nuevos_semana,
            count(*) FILTER (WHERE p.creado_en >= l.mes) AS nuevos_mes,
            count(*) FILTER (WHERE p.activo AND p.dni IS NULL) AS sin_dni,
            count(*) FILTER (WHERE p.activo AND p.id_obra_social IS NULL) AS sin_obra_social
     FROM paciente p CROSS JOIN limites l`,
  );
  const porObraSocial = await db.query<ResumenPacientes['por_obra_social'][number]>(
    `SELECT os.id AS id_obra_social, os.nombre, count(*) AS cantidad
     FROM paciente p JOIN obra_social os ON os.id = p.id_obra_social
     WHERE p.activo
     GROUP BY os.id, os.nombre
     ORDER BY count(*) DESC, lower(os.nombre)`,
  );
  return { ...rows[0]!, por_obra_social: porObraSocial.rows };
}
