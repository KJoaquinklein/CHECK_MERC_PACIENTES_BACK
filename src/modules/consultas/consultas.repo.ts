import type { Ejecutor } from '../../db/pool.js';
import type { ListarConsultas } from './consultas.schemas.js';

const ZONA = 'America/Argentina/Cordoba';

interface UsuarioResumen {
  id: number;
  nombre_completo: string;
}

/** Consulta con su versión vigente. */
export interface ConsultaVista {
  id: number;
  id_paciente: number;
  paciente: UsuarioResumen;
  fecha_consulta: Date;
  fecha_estimada: boolean;
  anulada: boolean;
  creado_en: Date;
  creada_por: UsuarioResumen | null;
  version_actual: number;
  contenido: string;
  motivo_edicion: string | null;
  editado_en: Date;
  editado_por: UsuarioResumen | null;
  fue_editada: boolean;
  total_versiones: number;
}

export interface VersionConsulta {
  version: number;
  contenido: string;
  motivo_edicion: string | null;
  creado_en: Date;
  usuario: UsuarioResumen | null;
}

export interface ConsultaDeLista {
  id: number;
  id_paciente: number;
  paciente: UsuarioResumen;
  fecha_consulta: Date;
  fecha_estimada: boolean;
  anulada: boolean;
  version_actual: number;
  fue_editada: boolean;
  extracto: string;
}

/**
 * Versión vigente de cada consulta: la de mayor `version`. Se obtiene con un LATERAL (equivale a
 * la vista `consulta_actual`, pero resuelve una consulta puntual sin recorrer toda la tabla).
 */
const VIGENTE = `
  JOIN LATERAL (
    SELECT version, contenido, motivo_edicion, creado_en, id_usuario, busqueda
    FROM consulta_contenido WHERE id_consulta = c.id
    ORDER BY version DESC LIMIT 1
  ) cc ON true`;

export async function obtenerConsulta(
  db: Ejecutor,
  id: number,
): Promise<ConsultaVista | undefined> {
  const { rows } = await db.query<ConsultaVista>(
    `SELECT c.id, c.id_paciente,
            json_build_object('id', p.id, 'nombre_completo', p.nombre_completo) AS paciente,
            c.fecha_consulta, c.fecha_estimada, c.anulada, c.creado_en,
            (SELECT json_build_object('id', u.id, 'nombre_completo', u.nombre_completo)
               FROM usuario u WHERE u.id = c.id_usuario) AS creada_por,
            cc.version AS version_actual, cc.contenido, cc.motivo_edicion,
            cc.creado_en AS editado_en,
            (SELECT json_build_object('id', u.id, 'nombre_completo', u.nombre_completo)
               FROM usuario u WHERE u.id = cc.id_usuario) AS editado_por,
            (cc.version > 0) AS fue_editada,
            (SELECT count(*) FROM consulta_contenido x WHERE x.id_consulta = c.id)
              AS total_versiones
     FROM consulta c
     JOIN paciente p ON p.id = c.id_paciente
     ${VIGENTE}
     WHERE c.id = $1`,
    [id],
  );
  return rows[0];
}

export interface ConsultaBloqueada {
  id: number;
  id_paciente: number;
  anulada: boolean;
  fecha_consulta: Date;
}

/** Bloquea la fila de la consulta: serializa las ediciones simultáneas. */
export async function bloquearConsulta(
  db: Ejecutor,
  id: number,
): Promise<ConsultaBloqueada | undefined> {
  const { rows } = await db.query<ConsultaBloqueada>(
    'SELECT id, id_paciente, anulada, fecha_consulta FROM consulta WHERE id = $1 FOR UPDATE',
    [id],
  );
  return rows[0];
}

/** Estado del paciente, con bloqueo compartido para que no se dé de baja a mitad de la operación. */
export async function estadoPaciente(
  db: Ejecutor,
  id: number,
): Promise<{ activo: boolean } | undefined> {
  const { rows } = await db.query<{ activo: boolean }>(
    'SELECT activo FROM paciente WHERE id = $1 FOR SHARE',
    [id],
  );
  return rows[0];
}

export async function insertarConsulta(
  db: Ejecutor,
  datos: { id_paciente: number; fecha_consulta?: string; id_usuario: number },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO consulta (id_paciente, fecha_consulta, id_usuario)
     VALUES ($1, COALESCE($2::timestamptz, now()), $3) RETURNING id`,
    [datos.id_paciente, datos.fecha_consulta ?? null, datos.id_usuario],
  );
  return rows[0]!.id;
}

export async function insertarContenido(
  db: Ejecutor,
  datos: {
    id_consulta: number;
    version: number;
    contenido: string;
    motivo_edicion?: string | null;
    id_usuario: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO consulta_contenido (id_consulta, version, contenido, motivo_edicion, id_usuario)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      datos.id_consulta,
      datos.version,
      datos.contenido,
      datos.motivo_edicion ?? null,
      datos.id_usuario,
    ],
  );
}

export async function versionVigente(
  db: Ejecutor,
  idConsulta: number,
): Promise<{ version: number; contenido: string }> {
  const { rows } = await db.query<{ version: number; contenido: string }>(
    `SELECT version, contenido FROM consulta_contenido
     WHERE id_consulta = $1 ORDER BY version DESC LIMIT 1`,
    [idConsulta],
  );
  return rows[0]!;
}

export async function listarVersiones(
  db: Ejecutor,
  idConsulta: number,
  version?: number,
): Promise<VersionConsulta[]> {
  const { rows } = await db.query<VersionConsulta>(
    `SELECT cc.version, cc.contenido, cc.motivo_edicion, cc.creado_en,
            (SELECT json_build_object('id', u.id, 'nombre_completo', u.nombre_completo)
               FROM usuario u WHERE u.id = cc.id_usuario) AS usuario
     FROM consulta_contenido cc
     WHERE cc.id_consulta = $1 AND ($2::int IS NULL OR cc.version = $2)
     ORDER BY cc.version ASC`,
    [idConsulta, version ?? null],
  );
  return rows;
}

export async function actualizarFecha(
  db: Ejecutor,
  id: number,
  fechaConsulta: string,
): Promise<void> {
  // Al fijar una fecha real deja de ser una fecha estimada (caso de consultas migradas)
  await db.query(
    'UPDATE consulta SET fecha_consulta = $2::timestamptz, fecha_estimada = false WHERE id = $1',
    [id, fechaConsulta],
  );
}

export async function cambiarAnulada(db: Ejecutor, id: number, anulada: boolean): Promise<void> {
  await db.query('UPDATE consulta SET anulada = $2 WHERE id = $1', [id, anulada]);
}

export async function listarConsultas(
  db: Ejecutor,
  filtros: ListarConsultas,
): Promise<{ filas: ConsultaDeLista[]; total: number }> {
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const agregar = (valor: unknown) => {
    valores.push(valor);
    return `$${valores.length}`;
  };

  if (!filtros.incluir_anuladas) condiciones.push('NOT c.anulada');
  if (filtros.id_paciente) condiciones.push(`c.id_paciente = ${agregar(filtros.id_paciente)}`);
  if (filtros.desde) {
    condiciones.push(
      `c.fecha_consulta >= (${agregar(filtros.desde)}::date)::timestamp AT TIME ZONE '${ZONA}'`,
    );
  }
  if (filtros.hasta) {
    condiciones.push(
      `c.fecha_consulta < (${agregar(filtros.hasta)}::date + 1)::timestamp AT TIME ZONE '${ZONA}'`,
    );
  }
  if (filtros.editadas !== undefined) {
    condiciones.push(`(cc.version > 0) = ${agregar(filtros.editadas)}`);
  }
  // Texto completo solo sobre la versión vigente (las anteriores no se buscan)
  if (filtros.q) {
    condiciones.push(`cc.busqueda @@ plainto_tsquery('es_unaccent', ${agregar(filtros.q)})`);
  }
  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const desde = `FROM consulta c JOIN paciente p ON p.id = c.id_paciente ${VIGENTE}`;

  const total = await db.query<{ total: number }>(
    `SELECT count(*) AS total ${desde} ${donde}`,
    valores,
  );

  // Orden y dirección salen de listas blancas (el esquema solo admite estos valores)
  const direccion = filtros.dir === 'asc' ? 'ASC' : 'DESC';
  const limite = agregar(filtros.page_size);
  const desplazamiento = agregar((filtros.page - 1) * filtros.page_size);
  const filas = await db.query<ConsultaDeLista>(
    `SELECT c.id, c.id_paciente,
            json_build_object('id', p.id, 'nombre_completo', p.nombre_completo) AS paciente,
            c.fecha_consulta, c.fecha_estimada, c.anulada, cc.version AS version_actual,
            (cc.version > 0) AS fue_editada, left(cc.contenido, 200) AS extracto
     ${desde} ${donde}
     ORDER BY c.fecha_consulta ${direccion}, c.id ${direccion}
     LIMIT ${limite} OFFSET ${desplazamiento}`,
    valores,
  );
  return { filas: filas.rows, total: total.rows[0]!.total };
}
