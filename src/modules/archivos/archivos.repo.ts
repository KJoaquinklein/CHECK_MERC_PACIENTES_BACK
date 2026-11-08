import type { Ejecutor } from '../../db/pool.js';
import type { ListarArchivos, TipoArchivo } from './archivos.schemas.js';

/** Metadatos tal como se devuelven por la API (nunca incluyen `storage_key`). */
export interface Archivo {
  id: number;
  id_paciente: number;
  id_consulta: number | null;
  tipo: TipoArchivo;
  descripcion: string | null;
  fecha_documento: string | null;
  nombre_original: string;
  mime_type: string;
  tamano_bytes: number;
  sha256: string;
  eliminado: boolean;
  eliminado_en: Date | null;
  creado_en: Date;
  subido_en: Date;
  subido_por: { id: number; nombre_completo: string } | null;
}

/** Fila interna: los metadatos más la clave del objeto, que no sale de la aplicación. */
export interface ArchivoInterno extends Archivo {
  storage_key: string;
}

const COLUMNAS = `
  a.id, a.id_paciente, a.id_consulta, a.tipo, a.descripcion, a.fecha_documento,
  a.nombre_original, a.mime_type, a.tamano_bytes, a.sha256, a.eliminado, a.eliminado_en,
  a.creado_en, a.subido_en,
  (SELECT json_build_object('id', u.id, 'nombre_completo', u.nombre_completo)
     FROM usuario u WHERE u.id = a.id_usuario) AS subido_por`;

export async function obtenerArchivo(
  db: Ejecutor,
  id: number,
  bloquear = false,
): Promise<ArchivoInterno | undefined> {
  // FOR UPDATE se aplica solo a la fila de paciente_archivo (la subconsulta no se bloquea)
  const { rows } = await db.query<ArchivoInterno>(
    `SELECT ${COLUMNAS}, a.storage_key FROM paciente_archivo a WHERE a.id = $1
     ${bloquear ? 'FOR UPDATE OF a' : ''}`,
    [id],
  );
  return rows[0];
}

export async function insertarArchivo(
  db: Ejecutor,
  datos: {
    id_paciente: number;
    id_consulta: number | null;
    tipo: TipoArchivo;
    descripcion: string | null;
    fecha_documento: string | null;
    nombre_original: string;
    mime_type: string;
    tamano_bytes: number;
    sha256: string;
    storage_key: string;
    id_usuario: number;
  },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO paciente_archivo (id_paciente, id_consulta, tipo, descripcion, fecha_documento,
                                   nombre_original, mime_type, tamano_bytes, sha256, storage_key,
                                   id_usuario)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      datos.id_paciente,
      datos.id_consulta,
      datos.tipo,
      datos.descripcion,
      datos.fecha_documento,
      datos.nombre_original,
      datos.mime_type,
      datos.tamano_bytes,
      datos.sha256,
      datos.storage_key,
      datos.id_usuario,
    ],
  );
  return rows[0]!.id;
}

/** Actualiza solo los campos presentes. Los nombres de columna salen de una lista fija. */
export async function actualizarMetadatos(
  db: Ejecutor,
  id: number,
  cambios: Partial<{
    descripcion: string | null;
    tipo: TipoArchivo;
    fecha_documento: string | null;
    id_consulta: number | null;
  }>,
): Promise<void> {
  const columnas = (['descripcion', 'tipo', 'fecha_documento', 'id_consulta'] as const).filter(
    (campo) => cambios[campo] !== undefined,
  );
  if (columnas.length === 0) return;
  await db.query(
    `UPDATE paciente_archivo SET ${columnas.map((campo, i) => `${campo} = $${i + 2}`).join(', ')}
     WHERE id = $1`,
    [id, ...columnas.map((campo) => cambios[campo])],
  );
}

export async function cambiarEliminado(db: Ejecutor, id: number, eliminado: boolean) {
  await db.query(
    'UPDATE paciente_archivo SET eliminado = $2, eliminado_en = CASE WHEN $2 THEN now() END WHERE id = $1',
    [id, eliminado],
  );
}

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

export async function datosDeConsulta(
  db: Ejecutor,
  id: number,
): Promise<{ id_paciente: number; anulada: boolean } | undefined> {
  const { rows } = await db.query<{ id_paciente: number; anulada: boolean }>(
    'SELECT id_paciente, anulada FROM consulta WHERE id = $1',
    [id],
  );
  return rows[0];
}

export async function listarArchivos(
  db: Ejecutor,
  filtros: ListarArchivos,
): Promise<{ filas: Archivo[]; total: number }> {
  const condiciones: string[] = [];
  const valores: unknown[] = [];
  const agregar = (valor: unknown) => {
    valores.push(valor);
    return `$${valores.length}`;
  };

  if (!filtros.incluir_eliminados) condiciones.push('NOT a.eliminado');
  if (filtros.id_paciente) condiciones.push(`a.id_paciente = ${agregar(filtros.id_paciente)}`);
  if (filtros.tipo) condiciones.push(`a.tipo = ${agregar(filtros.tipo)}`);
  if (filtros.mime_type) condiciones.push(`a.mime_type = ${agregar(filtros.mime_type)}`);
  if (filtros.desde) condiciones.push(`a.fecha_documento >= ${agregar(filtros.desde)}::date`);
  if (filtros.hasta) condiciones.push(`a.fecha_documento <= ${agregar(filtros.hasta)}::date`);
  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const total = await db.query<{ total: number }>(
    `SELECT count(*) AS total FROM paciente_archivo a ${donde}`,
    valores,
  );

  // Columna y dirección salen de listas blancas (el esquema solo admite estos valores)
  const columna = filtros.orden === 'fecha_documento' ? 'a.fecha_documento' : 'a.subido_en';
  const direccion = filtros.dir === 'asc' ? 'ASC' : 'DESC';
  const limite = agregar(filtros.page_size);
  const desplazamiento = agregar((filtros.page - 1) * filtros.page_size);
  const filas = await db.query<Archivo>(
    `SELECT ${COLUMNAS} FROM paciente_archivo a ${donde}
     ORDER BY ${columna} ${direccion} NULLS LAST, a.id ${direccion}
     LIMIT ${limite} OFFSET ${desplazamiento}`,
    valores,
  );
  return { filas: filas.rows, total: total.rows[0]!.total };
}
