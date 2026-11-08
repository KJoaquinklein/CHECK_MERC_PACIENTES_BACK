import type { Ejecutor } from '../../db/pool.js';
import type { Periodo } from './reportes.schemas.js';

const ZONA = 'America/Argentina/Cordoba';

/**
 * Serie mensual con los meses sin datos en cero. `datos` es un CTE con la columna `mes` (primer
 * día del mes, en hora de Córdoba) y las métricas; el rango va de `desde`/`hasta` o, si faltan,
 * del primer al último mes con datos. Los parámetros $1 y $2 son `desde` y `hasta`.
 */
function serieMensual(datos: string, metricas: string[]): string {
  return `
    WITH datos AS (${datos}),
    rango AS (
      SELECT COALESCE(date_trunc('month', $1::date::timestamp), min(mes)::timestamp) AS inicio,
             COALESCE(date_trunc('month', $2::date::timestamp), max(mes)::timestamp) AS fin
      FROM datos
    )
    SELECT m.mes::date AS mes, ${metricas.map((m) => `COALESCE(d.${m}, 0) AS ${m}`).join(', ')}
    FROM rango r
    CROSS JOIN LATERAL generate_series(r.inicio, r.fin, interval '1 month') AS m(mes)
    LEFT JOIN datos d ON d.mes = m.mes::date
    ORDER BY m.mes`;
}

/** Condición de rango de días completos sobre una columna timestamptz ($1 desde, $2 hasta). */
function enRango(columna: string): string {
  return `($1::date IS NULL OR ${columna} >= $1::date::timestamp AT TIME ZONE '${ZONA}')
    AND ($2::date IS NULL OR ${columna} < ($2::date + 1)::timestamp AT TIME ZONE '${ZONA}')`;
}

const parametros = (p: Periodo) => [p.desde ?? null, p.hasta ?? null];

export interface ConsultasDelMes {
  mes: string;
  consultas: number;
}

/** Consultas no anuladas por mes de la fecha clínica. */
export async function consultasPorMes(db: Ejecutor, p: Periodo): Promise<ConsultasDelMes[]> {
  const { rows } = await db.query<ConsultasDelMes>(
    serieMensual(
      `SELECT date_trunc('month', fecha_consulta AT TIME ZONE '${ZONA}')::date AS mes,
              count(*) AS consultas
       FROM consulta WHERE NOT anulada AND ${enRango('fecha_consulta')} GROUP BY 1`,
      ['consultas'],
    ),
    parametros(p),
  );
  return rows;
}

export interface PacientesNuevosDelMes {
  mes: string;
  pacientes_nuevos: number;
}

/** Altas de pacientes por mes (incluye a los dados de baja después). */
export async function pacientesNuevosPorMes(
  db: Ejecutor,
  p: Periodo,
): Promise<PacientesNuevosDelMes[]> {
  const { rows } = await db.query<PacientesNuevosDelMes>(
    serieMensual(
      `SELECT date_trunc('month', creado_en AT TIME ZONE '${ZONA}')::date AS mes,
              count(*) AS pacientes_nuevos
       FROM paciente WHERE ${enRango('creado_en')} GROUP BY 1`,
      ['pacientes_nuevos'],
    ),
    parametros(p),
  );
  return rows;
}

export interface EdicionesDelMes {
  mes: string;
  ediciones: number;
  consultas_modificadas: number;
}

/** Versiones nuevas (version > 0) por mes y cuántas consultas distintas modificaron. */
export async function edicionesPorMes(db: Ejecutor, p: Periodo): Promise<EdicionesDelMes[]> {
  const { rows } = await db.query<EdicionesDelMes>(
    serieMensual(
      `SELECT date_trunc('month', creado_en AT TIME ZONE '${ZONA}')::date AS mes,
              count(*) AS ediciones, count(DISTINCT id_consulta) AS consultas_modificadas
       FROM consulta_contenido WHERE version > 0 AND ${enRango('creado_en')} GROUP BY 1`,
      ['ediciones', 'consultas_modificadas'],
    ),
    parametros(p),
  );
  return rows;
}

export interface PacientesDeObraSocial {
  id_obra_social: number | null;
  nombre: string;
  cantidad: number;
}

/** Pacientes activos por obra social; los que no tienen ninguna figuran como "Sin obra social". */
export async function pacientesPorObraSocial(db: Ejecutor): Promise<PacientesDeObraSocial[]> {
  const { rows } = await db.query<PacientesDeObraSocial>(
    `SELECT os.id AS id_obra_social, COALESCE(os.nombre, 'Sin obra social') AS nombre,
            count(*) AS cantidad
     FROM paciente p LEFT JOIN obra_social os ON os.id = p.id_obra_social
     WHERE p.activo
     GROUP BY os.id, os.nombre
     ORDER BY count(*) DESC, os.id IS NULL, lower(os.nombre)`,
  );
  return rows;
}

export interface PacienteConConsultas {
  id_paciente: number;
  nombre_completo: string;
  consultas: number;
  ultima_consulta: Date;
}

/** Pacientes con más consultas no anuladas en el período. */
export async function consultasPorPaciente(
  db: Ejecutor,
  p: Periodo,
  limite: number,
): Promise<PacienteConConsultas[]> {
  const { rows } = await db.query<PacienteConConsultas>(
    `SELECT p.id AS id_paciente, p.nombre_completo, count(*) AS consultas,
            max(c.fecha_consulta) AS ultima_consulta
     FROM consulta c JOIN paciente p ON p.id = c.id_paciente
     WHERE NOT c.anulada AND ${enRango('c.fecha_consulta')}
     GROUP BY p.id, p.nombre_completo
     ORDER BY count(*) DESC, lower(p.nombre_completo), p.id
     LIMIT $3`,
    [...parametros(p), limite],
  );
  return rows;
}

export interface ResumenGeneral {
  pacientes_total: number;
  pacientes_activos: number;
  consultas_total: number;
  consultas_del_mes: number;
  ediciones_del_mes: number;
  archivos_total: number;
  archivos_estudios: number;
  archivos_fichas_antiguas: number;
}

/** Indicadores generales. "Del mes" es el mes calendario actual en hora de Córdoba. */
export async function resumenGeneral(db: Ejecutor): Promise<ResumenGeneral> {
  const { rows } = await db.query<ResumenGeneral>(
    `WITH mes AS (
       SELECT date_trunc('month', now() AT TIME ZONE '${ZONA}') AT TIME ZONE '${ZONA}' AS inicio,
              (date_trunc('month', now() AT TIME ZONE '${ZONA}') + interval '1 month')
                AT TIME ZONE '${ZONA}' AS fin
     )
     SELECT
       (SELECT count(*) FROM paciente) AS pacientes_total,
       (SELECT count(*) FROM paciente WHERE activo) AS pacientes_activos,
       (SELECT count(*) FROM consulta WHERE NOT anulada) AS consultas_total,
       (SELECT count(*) FROM consulta c, mes WHERE NOT c.anulada
          AND c.fecha_consulta >= mes.inicio AND c.fecha_consulta < mes.fin) AS consultas_del_mes,
       (SELECT count(*) FROM consulta_contenido cc, mes WHERE cc.version > 0
          AND cc.creado_en >= mes.inicio AND cc.creado_en < mes.fin) AS ediciones_del_mes,
       (SELECT count(*) FROM paciente_archivo WHERE NOT eliminado) AS archivos_total,
       (SELECT count(*) FROM paciente_archivo WHERE NOT eliminado AND tipo = 'estudio')
         AS archivos_estudios,
       (SELECT count(*) FROM paciente_archivo WHERE NOT eliminado AND tipo = 'ficha_antigua')
         AS archivos_fichas_antiguas`,
  );
  return rows[0]!;
}
