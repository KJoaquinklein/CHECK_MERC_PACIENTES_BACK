import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type pg from 'pg';
import type { Logger } from 'pino';
import { conTransaccion } from '../../db/tx.js';
import { AppError, errores } from '../../errors.js';
import {
  StorageObjectNotFound,
  StorageOperationNotSupported,
  type StorageDriver,
} from '../../storage/driver.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { respuestaPaginada } from '../comun/sql.js';
import * as repo from './archivos.repo.js';
import type {
  CamposSubida,
  EditarArchivo,
  ListarArchivos,
  TipoArchivo,
} from './archivos.schemas.js';
import { sanitizarNombre, type SubidaRecibida } from './subida.js';

export interface Actor {
  id: number;
  ip: string | null;
}

const noExiste = () => errores.noEncontrado('El archivo no existe');

const PREFIJO_POR_TIPO: Record<TipoArchivo, string> = {
  estudio: 'estudios',
  ficha_antigua: 'fichas-antiguas',
};

const pacienteInactivo = () =>
  errores.conflicto(
    'PACIENTE_INACTIVO',
    'El paciente está dado de baja: reactivalo para poder subir o modificar archivos',
  );

const archivoEliminado = () =>
  errores.conflicto(
    'ARCHIVO_ELIMINADO',
    'El archivo está eliminado: restauralo antes de modificarlo',
  );

function sinClave({ storage_key: _clave, ...archivo }: repo.ArchivoInterno): repo.Archivo {
  return archivo;
}

/** Las fichas antiguas son imágenes escaneadas: no se admite un PDF con ese tipo. */
function exigirMimeCompatible(tipo: TipoArchivo, mime: string) {
  if (tipo === 'ficha_antigua' && mime === 'application/pdf') {
    throw errores.reglaDeNegocio(
      'TIPO_INCOMPATIBLE',
      'Una ficha antigua debe ser una imagen (PNG o JPEG); los PDF se cargan como estudio',
    );
  }
}

/** Rule 1 y 8 del plan: paciente activo y consulta (opcional) del mismo paciente y no anulada. */
async function validarVinculos(
  db: pg.Pool | pg.PoolClient,
  idPaciente: number,
  idConsulta: number | null | undefined,
) {
  const paciente = await repo.estadoPaciente(db, idPaciente);
  if (!paciente) {
    throw errores.reglaDeNegocio('PACIENTE_INVALIDO', 'El paciente indicado no existe');
  }
  if (!paciente.activo) throw pacienteInactivo();

  if (idConsulta !== null && idConsulta !== undefined) {
    const consulta = await repo.datosDeConsulta(db, idConsulta);
    if (!consulta || consulta.id_paciente !== idPaciente) {
      throw errores.reglaDeNegocio(
        'CONSULTA_INVALIDA',
        'La consulta indicada no existe o pertenece a otro paciente',
      );
    }
    if (consulta.anulada) {
      throw errores.reglaDeNegocio('CONSULTA_ANULADA', 'La consulta indicada está anulada');
    }
  }
}

export async function listar(pool: pg.Pool, filtros: ListarArchivos) {
  const { filas, total } = await repo.listarArchivos(pool, filtros);
  return respuestaPaginada(filas, filtros.page, filtros.page_size, total);
}

/**
 * Guarda el objeto en el almacenamiento y después inserta la fila. Si la inserción falla, el
 * objeto recién subido se borra (no quedan archivos huérfanos).
 */
export async function subir(
  deps: { pool: pg.Pool; storage: StorageDriver; log: Pick<Logger, 'error'> },
  actor: Actor,
  campos: CamposSubida,
  subida: SubidaRecibida['archivo'],
): Promise<repo.Archivo> {
  const { pool, storage, log } = deps;
  exigirMimeCompatible(campos.tipo, subida.mime);
  // Antes de transferir el archivo al almacenamiento se descartan los pedidos inválidos
  await validarVinculos(pool, campos.id_paciente, campos.id_consulta);

  const key = `${PREFIJO_POR_TIPO[campos.tipo]}/${campos.id_paciente}/${randomUUID()}.${subida.extension}`;
  await storage.put(key, createReadStream(subida.rutaTemporal), {
    mime: subida.mime,
    size: subida.bytes,
  });

  try {
    return await conTransaccion(pool, async (cliente) => {
      await validarVinculos(cliente, campos.id_paciente, campos.id_consulta);
      const id = await repo.insertarArchivo(cliente, {
        id_paciente: campos.id_paciente,
        id_consulta: campos.id_consulta ?? null,
        tipo: campos.tipo,
        descripcion: campos.descripcion ?? null,
        fecha_documento: campos.fecha_documento ?? null,
        nombre_original: sanitizarNombre(subida.nombreOriginal, subida.extension),
        mime_type: subida.mime,
        tamano_bytes: subida.bytes,
        sha256: subida.sha256,
        storage_key: key,
        id_usuario: actor.id,
      });
      await registrarAuditoria(cliente, {
        idUsuario: actor.id,
        accion: 'archivo_subir',
        entidad: 'archivo',
        entidadId: id,
        ip: actor.ip,
        // Sin el nombre del archivo: puede contener el nombre del paciente o datos clínicos
        detalle: {
          id_paciente: campos.id_paciente,
          tipo: campos.tipo,
          mime_type: subida.mime,
          tamano_bytes: subida.bytes,
        },
      });
      return sinClave((await repo.obtenerArchivo(cliente, id))!);
    });
  } catch (error) {
    try {
      await storage.delete(key);
    } catch (errorLimpieza) {
      log.error(
        { err: errorLimpieza, key },
        'No se pudo borrar el objeto de una subida fallida: queda huérfano en el almacenamiento',
      );
    }
    throw error;
  }
}

/** Metadatos de un archivo (también si está eliminado, para poder restaurarlo). */
export async function ver(pool: pg.Pool, actor: Actor, id: number): Promise<repo.Archivo> {
  const archivo = await repo.obtenerArchivo(pool, id);
  if (!archivo) throw noExiste();
  await registrarAuditoria(pool, {
    idUsuario: actor.id,
    accion: 'ver_archivo',
    entidad: 'archivo',
    entidadId: id,
    ip: actor.ip,
    detalle: { vista: 'metadatos' },
  });
  return sinClave(archivo);
}

/** Encabezado Content-Disposition inline con el nombre original, seguro y con soporte UTF-8. */
export function contentDisposition(nombre: string): string {
  const ascii = nombre.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export type Descarga =
  | { modo: 'stream'; archivo: repo.Archivo; stream: Readable; disposicion: string }
  | { modo: 'redirect'; url: string };

/**
 * Prepara la descarga y registra `ver_archivo`. En modo `redirect` con el driver S3 devuelve una
 * URL firmada de corta duración; en cualquier otro caso, el flujo de bytes para transmitirlo.
 */
export async function prepararDescarga(
  deps: {
    pool: pg.Pool;
    storage: StorageDriver;
    log: Pick<Logger, 'error'>;
    modo: 'stream' | 'redirect';
    ttlSegundos: number;
  },
  actor: Actor,
  id: number,
): Promise<Descarga> {
  const { pool, storage, log } = deps;
  const archivo = await repo.obtenerArchivo(pool, id);
  if (!archivo) throw noExiste();
  if (archivo.eliminado) {
    throw new AppError(404, 'ARCHIVO_ELIMINADO', 'El archivo está eliminado');
  }
  const disposicion = contentDisposition(archivo.nombre_original);
  const auditar = () =>
    registrarAuditoria(pool, {
      idUsuario: actor.id,
      accion: 'ver_archivo',
      entidad: 'archivo',
      entidadId: id,
      ip: actor.ip,
      detalle: { vista: 'contenido' },
    });

  if (deps.modo === 'redirect') {
    try {
      const url = await storage.getSignedUrl(archivo.storage_key, deps.ttlSegundos, {
        contentType: archivo.mime_type,
        contentDisposition: disposicion,
      });
      await auditar();
      return { modo: 'redirect', url };
    } catch (error) {
      // El driver local no firma URLs: se transmite a través del backend
      if (!(error instanceof StorageOperationNotSupported)) throw error;
    }
  }

  let stream: Readable;
  try {
    stream = await storage.getStream(archivo.storage_key);
  } catch (error) {
    if (error instanceof StorageObjectNotFound) {
      log.error({ id_archivo: id, key: archivo.storage_key }, 'Falta el objeto de un archivo');
      throw new AppError(
        404,
        'ARCHIVO_NO_DISPONIBLE',
        'El contenido del archivo no está disponible',
      );
    }
    throw error;
  }
  try {
    await auditar();
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return { modo: 'stream', archivo: sinClave(archivo), stream, disposicion };
}

/** Edita los metadatos; el binario no cambia. */
export async function editar(
  pool: pg.Pool,
  actor: Actor,
  id: number,
  cambios: EditarArchivo,
): Promise<repo.Archivo> {
  return conTransaccion(pool, async (cliente) => {
    const actual = await repo.obtenerArchivo(cliente, id, true);
    if (!actual) throw noExiste();
    if (actual.eliminado) throw archivoEliminado();
    const paciente = await repo.estadoPaciente(cliente, actual.id_paciente);
    if (!paciente?.activo) throw pacienteInactivo();

    const campos = (['descripcion', 'tipo', 'fecha_documento', 'id_consulta'] as const).filter(
      (campo) => cambios[campo] !== undefined && cambios[campo] !== actual[campo],
    );
    if (campos.length === 0) return sinClave(actual);

    if (campos.includes('tipo')) exigirMimeCompatible(cambios.tipo!, actual.mime_type);
    if (campos.includes('id_consulta')) {
      await validarVinculos(cliente, actual.id_paciente, cambios.id_consulta);
    }
    await repo.actualizarMetadatos(
      cliente,
      id,
      Object.fromEntries(campos.map((campo) => [campo, cambios[campo]])),
    );

    // La descripción puede contener datos clínicos: solo se deja constancia de que cambió
    const conValores = campos.filter((campo) => campo !== 'descripcion');
    await registrarAuditoria(cliente, {
      idUsuario: actor.id,
      accion: 'archivo_editar',
      entidad: 'archivo',
      entidadId: id,
      ip: actor.ip,
      detalle: {
        campos,
        antes: Object.fromEntries(conValores.map((campo) => [campo, actual[campo]])),
        despues: Object.fromEntries(conValores.map((campo) => [campo, cambios[campo]])),
      },
    });
    return sinClave((await repo.obtenerArchivo(cliente, id))!);
  });
}

async function cambiarEliminado(pool: pg.Pool, actor: Actor, id: number, eliminado: boolean) {
  return conTransaccion(pool, async (cliente) => {
    const actual = await repo.obtenerArchivo(cliente, id, true);
    if (!actual) throw noExiste();
    // Repetir la operación no cambia nada ni genera un registro de auditoría de más
    if (actual.eliminado === eliminado) return sinClave(actual);
    const paciente = await repo.estadoPaciente(cliente, actual.id_paciente);
    if (!paciente?.activo) throw pacienteInactivo();

    await repo.cambiarEliminado(cliente, id, eliminado);
    await registrarAuditoria(cliente, {
      idUsuario: actor.id,
      accion: eliminado ? 'archivo_baja' : 'archivo_restaurar',
      entidad: 'archivo',
      entidadId: id,
      ip: actor.ip,
    });
    return sinClave((await repo.obtenerArchivo(cliente, id))!);
  });
}

/** Baja lógica: el objeto se conserva en el almacenamiento. */
export const darDeBaja = (pool: pg.Pool, actor: Actor, id: number) =>
  cambiarEliminado(pool, actor, id, true);

export const restaurar = (pool: pg.Pool, actor: Actor, id: number) =>
  cambiarEliminado(pool, actor, id, false);
