import type pg from 'pg';
import { conTransaccion } from '../../db/tx.js';
import { AppError, errores } from '../../errors.js';
import { registrarAuditoria, type AccionAuditoria } from '../auditoria/auditoria.service.js';
import { esViolacionUnicidad, respuestaPaginada } from '../comun/sql.js';
import * as repo from './consultas.repo.js';
import type { ListarConsultas } from './consultas.schemas.js';

export interface Actor {
  id: number;
  ip: string | null;
}

const noExiste = () => errores.noEncontrado('La consulta no existe');

const consultaAnulada = () =>
  errores.reglaDeNegocio(
    'CONSULTA_ANULADA',
    'La consulta está anulada: restaurala antes de modificarla',
  );

const pacienteInactivo = () =>
  errores.conflicto(
    'PACIENTE_INACTIVO',
    'El paciente está dado de baja: reactivalo para poder registrar o modificar consultas',
  );

function conflictoDeVersion(versionVigente: number) {
  return new AppError(
    409,
    'CONFLICTO_VERSION',
    'La consulta fue modificada por otra persona: volvé a cargarla antes de editar',
    [{ version_vigente: versionVigente }],
  );
}

/** El paciente debe existir y estar activo para recibir o modificar consultas. */
async function exigirPacienteActivo(cliente: pg.PoolClient, idPaciente: number) {
  const paciente = await repo.estadoPaciente(cliente, idPaciente);
  if (!paciente) {
    throw errores.reglaDeNegocio('PACIENTE_INVALIDO', 'El paciente indicado no existe');
  }
  if (!paciente.activo) throw pacienteInactivo();
}

async function vistaObligatoria(cliente: pg.PoolClient, id: number) {
  return (await repo.obtenerConsulta(cliente, id))!;
}

export async function listar(pool: pg.Pool, filtros: ListarConsultas) {
  const { filas, total } = await repo.listarConsultas(pool, filtros);
  return respuestaPaginada(filas, filtros.page, filtros.page_size, total);
}

/** Crea la consulta y su versión 0 en una sola transacción, junto con la auditoría. */
export async function crear(
  pool: pg.Pool,
  actor: Actor,
  datos: { id_paciente: number; fecha_consulta?: string; contenido: string },
) {
  return conTransaccion(pool, async (cliente) => {
    await exigirPacienteActivo(cliente, datos.id_paciente);
    const id = await repo.insertarConsulta(cliente, {
      id_paciente: datos.id_paciente,
      fecha_consulta: datos.fecha_consulta,
      id_usuario: actor.id,
    });
    await repo.insertarContenido(cliente, {
      id_consulta: id,
      version: 0,
      contenido: datos.contenido,
      id_usuario: actor.id,
    });
    await registrarAuditoria(cliente, {
      idUsuario: actor.id,
      accion: 'consulta_crear',
      entidad: 'consulta',
      entidadId: id,
      ip: actor.ip,
      detalle: { id_paciente: datos.id_paciente },
    });
    return vistaObligatoria(cliente, id);
  });
}

/** Consulta con su versión vigente. Registra `ver_consulta`. */
export async function ver(pool: pg.Pool, actor: Actor, id: number) {
  const consulta = await repo.obtenerConsulta(pool, id);
  if (!consulta) throw noExiste();
  await registrarAuditoria(pool, {
    idUsuario: actor.id,
    accion: 'ver_consulta',
    entidad: 'consulta',
    entidadId: id,
    ip: actor.ip,
    detalle: { vista: 'actual', version: consulta.version_actual },
  });
  return consulta;
}

/** Historial completo (o una versión puntual). Leerlo también queda auditado como `ver_consulta`. */
export async function verVersiones(pool: pg.Pool, actor: Actor, id: number, version?: number) {
  const versiones = await repo.listarVersiones(pool, id, version);
  if (versiones.length === 0) {
    throw version === undefined ? noExiste() : errores.noEncontrado('La versión no existe');
  }
  await registrarAuditoria(pool, {
    idUsuario: actor.id,
    accion: 'ver_consulta',
    entidad: 'consulta',
    entidadId: id,
    ip: actor.ip,
    detalle: version === undefined ? { vista: 'versiones' } : { vista: 'version', version },
  });
  return version === undefined ? versiones : versiones[0]!;
}

/**
 * Nueva edición = nueva versión. Sigue el orden del plan (sección 5.3): se bloquea la consulta,
 * se compara `version_base` con la vigente y recién entonces se inserta. Dos ediciones con la
 * misma versión base producen exactamente un éxito y un conflicto.
 */
export async function editar(
  pool: pg.Pool,
  actor: Actor,
  id: number,
  datos: { contenido: string; version_base: number; motivo_edicion?: string | null },
) {
  try {
    return await conTransaccion(pool, async (cliente) => {
      const consulta = await repo.bloquearConsulta(cliente, id);
      if (!consulta) throw noExiste();
      if (consulta.anulada) throw consultaAnulada();
      await exigirPacienteActivo(cliente, consulta.id_paciente);

      const vigente = await repo.versionVigente(cliente, id);
      if (vigente.version !== datos.version_base) throw conflictoDeVersion(vigente.version);
      if (vigente.contenido.trim() === datos.contenido) {
        throw errores.reglaDeNegocio(
          'CONTENIDO_SIN_CAMBIOS',
          'El contenido es idéntico al de la versión vigente',
        );
      }

      const nueva = vigente.version + 1;
      await repo.insertarContenido(cliente, {
        id_consulta: id,
        version: nueva,
        contenido: datos.contenido,
        motivo_edicion: datos.motivo_edicion,
        id_usuario: actor.id,
      });
      await registrarAuditoria(cliente, {
        idUsuario: actor.id,
        accion: 'consulta_editar',
        entidad: 'consulta',
        entidadId: id,
        ip: actor.ip,
        // El motivo puede contener texto clínico: solo se registra si lo hubo
        detalle: {
          version_anterior: vigente.version,
          version_nueva: nueva,
          con_motivo: Boolean(datos.motivo_edicion),
        },
      });
      return vistaObligatoria(cliente, id);
    });
  } catch (error) {
    // Respaldo del UNIQUE (id_consulta, version) ante cualquier carrera que el bloqueo no cubra
    if (esViolacionUnicidad(error)) {
      const vigente = await repo.versionVigente(pool, id);
      throw conflictoDeVersion(vigente.version);
    }
    throw error;
  }
}

/** Cambia la fecha clínica. No toca el contenido ni genera versiones. */
export async function cambiarFecha(pool: pg.Pool, actor: Actor, id: number, fecha: string) {
  return conTransaccion(pool, async (cliente) => {
    const consulta = await repo.bloquearConsulta(cliente, id);
    if (!consulta) throw noExiste();
    if (consulta.anulada) throw consultaAnulada();
    await exigirPacienteActivo(cliente, consulta.id_paciente);

    if (new Date(fecha).getTime() === consulta.fecha_consulta.getTime()) {
      return vistaObligatoria(cliente, id);
    }
    await repo.actualizarFecha(cliente, id, fecha);
    const nueva = await vistaObligatoria(cliente, id);
    await registrarAuditoria(cliente, {
      idUsuario: actor.id,
      accion: 'consulta_cambiar_fecha',
      entidad: 'consulta',
      entidadId: id,
      ip: actor.ip,
      detalle: {
        antes: consulta.fecha_consulta.toISOString(),
        despues: nueva.fecha_consulta.toISOString(),
      },
    });
    return nueva;
  });
}

async function cambiarAnulada(pool: pg.Pool, actor: Actor, id: number, anulada: boolean) {
  const accion: AccionAuditoria = anulada ? 'consulta_anular' : 'consulta_restaurar';
  return conTransaccion(pool, async (cliente) => {
    const consulta = await repo.bloquearConsulta(cliente, id);
    if (!consulta) throw noExiste();
    // Repetir la operación no cambia nada ni genera un registro de auditoría de más
    if (consulta.anulada === anulada) return vistaObligatoria(cliente, id);
    await exigirPacienteActivo(cliente, consulta.id_paciente);

    await repo.cambiarAnulada(cliente, id, anulada);
    await registrarAuditoria(cliente, {
      idUsuario: actor.id,
      accion,
      entidad: 'consulta',
      entidadId: id,
      ip: actor.ip,
    });
    return vistaObligatoria(cliente, id);
  });
}

/** Baja lógica: la consulta y todas sus versiones se conservan. */
export const anular = (pool: pg.Pool, actor: Actor, id: number) =>
  cambiarAnulada(pool, actor, id, true);

export const restaurar = (pool: pg.Pool, actor: Actor, id: number) =>
  cambiarAnulada(pool, actor, id, false);
