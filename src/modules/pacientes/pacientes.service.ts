import type pg from 'pg';
import { conTransaccion } from '../../db/tx.js';
import { errores } from '../../errors.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { respuestaPaginada, restriccionViolada, esViolacionUnicidad } from '../comun/sql.js';
import * as repo from './pacientes.repo.js';
import type { FiltrosPacientes, ListarPacientes } from './pacientes.schemas.js';

export interface Actor {
  id: number;
  ip: string | null;
}

/**
 * Campos cuyo valor anterior y posterior se guarda en la auditoría. `observaciones` solo deja
 * constancia de que cambió: puede contener texto clínico, que nunca va en la auditoría.
 */
const CAMPOS_CON_VALORES_EN_AUDITORIA = new Set<repo.CampoEditable>([
  'nombre_completo',
  'dni',
  'fecha_nacimiento',
  'telefono',
  'email',
  'domicilio',
  'id_obra_social',
  'nro_afiliado',
]);

const noExiste = () => errores.noEncontrado('El paciente no existe');

function traducirErrorUnicidad(error: unknown): never {
  if (esViolacionUnicidad(error) && restriccionViolada(error) === 'paciente_dni_uk') {
    throw errores.conflicto('DNI_DUPLICADO', 'Ya existe un paciente con ese DNI');
  }
  throw error;
}

/** La obra social debe existir y estar activa (conservar una que se dio de baja no pasa por acá). */
async function validarObraSocial(db: pg.PoolClient, id: number | null | undefined) {
  if (id === null || id === undefined) return;
  const obraSocial = await repo.estadoObraSocial(db, id);
  if (!obraSocial) {
    throw errores.reglaDeNegocio('OBRA_SOCIAL_INVALIDA', 'La obra social indicada no existe');
  }
  if (!obraSocial.activa) {
    throw errores.reglaDeNegocio(
      'OBRA_SOCIAL_INACTIVA',
      'La obra social indicada está dada de baja',
    );
  }
}

export async function listar(pool: pg.Pool, filtros: ListarPacientes) {
  const { filas, total } = await repo.listarPacientes(pool, filtros);
  return respuestaPaginada(filas, filtros.page, filtros.page_size, total);
}

export async function contar(pool: pg.Pool, filtros: FiltrosPacientes) {
  return { total: await repo.contarPacientes(pool, filtros) };
}

export function resumen(pool: pg.Pool) {
  return repo.resumenDePacientes(pool);
}

export async function crear(
  pool: pg.Pool,
  actor: Actor,
  datos: repo.DatosPaciente,
): Promise<repo.Paciente> {
  try {
    return await conTransaccion(pool, async (cliente) => {
      await validarObraSocial(cliente, datos.id_obra_social as number | null | undefined);
      const id = await repo.insertarPaciente(cliente, datos);
      await registrarAuditoria(cliente, {
        idUsuario: actor.id,
        accion: 'paciente_crear',
        entidad: 'paciente',
        entidadId: id,
        ip: actor.ip,
        detalle: {
          campos: Object.keys(datos).filter((campo) => datos[campo as repo.CampoEditable] != null),
        },
      });
      return (await repo.obtenerPaciente(cliente, id))!;
    });
  } catch (error) {
    return traducirErrorUnicidad(error);
  }
}

/** Ficha completa con su resumen. Registra `ver_paciente`. */
export async function verFicha(pool: pg.Pool, actor: Actor, id: number) {
  const paciente = await repo.obtenerPaciente(pool, id);
  if (!paciente) throw noExiste();
  const resumen = await repo.resumenDePaciente(pool, id);
  await registrarAuditoria(pool, {
    idUsuario: actor.id,
    accion: 'ver_paciente',
    entidad: 'paciente',
    entidadId: id,
    ip: actor.ip,
  });
  return { ...paciente, resumen };
}

/**
 * Edición parcial: guarda en la auditoría el antes y el después de los campos que cambiaron.
 * Un paciente dado de baja no se edita hasta reactivarlo.
 */
export async function editar(
  pool: pg.Pool,
  actor: Actor,
  id: number,
  cambios: repo.DatosPaciente,
): Promise<repo.Paciente> {
  try {
    return await conTransaccion(pool, async (cliente) => {
      const actual = await repo.obtenerPaciente(cliente, id, true);
      if (!actual) throw noExiste();
      if (!actual.activo) {
        throw errores.conflicto(
          'PACIENTE_INACTIVO',
          'El paciente está dado de baja: reactivalo para poder modificarlo',
        );
      }

      const modificados = repo.CAMPOS_EDITABLES.filter(
        (campo) => cambios[campo] !== undefined && cambios[campo] !== actual[campo],
      );
      if (modificados.length === 0) return actual;

      if (modificados.includes('id_obra_social')) {
        await validarObraSocial(cliente, cambios.id_obra_social as number | null);
      }
      await repo.actualizarPaciente(
        cliente,
        id,
        Object.fromEntries(modificados.map((campo) => [campo, cambios[campo]])),
      );

      const conValores = modificados.filter((campo) => CAMPOS_CON_VALORES_EN_AUDITORIA.has(campo));
      await registrarAuditoria(cliente, {
        idUsuario: actor.id,
        accion: 'paciente_editar',
        entidad: 'paciente',
        entidadId: id,
        ip: actor.ip,
        detalle: {
          campos: modificados,
          antes: Object.fromEntries(conValores.map((campo) => [campo, actual[campo]])),
          despues: Object.fromEntries(conValores.map((campo) => [campo, cambios[campo]])),
        },
      });
      return (await repo.obtenerPaciente(cliente, id))!;
    });
  } catch (error) {
    return traducirErrorUnicidad(error);
  }
}

async function cambiarActivo(
  pool: pg.Pool,
  actor: Actor,
  id: number,
  activo: boolean,
): Promise<repo.Paciente> {
  return conTransaccion(pool, async (cliente) => {
    const actual = await repo.obtenerPaciente(cliente, id, true);
    if (!actual) throw noExiste();
    // Repetir la operación no cambia nada ni genera un registro de auditoría de más
    if (actual.activo === activo) return actual;

    await repo.cambiarEstado(cliente, id, activo);
    await registrarAuditoria(cliente, {
      idUsuario: actor.id,
      accion: activo ? 'paciente_reactivar' : 'paciente_baja',
      entidad: 'paciente',
      entidadId: id,
      ip: actor.ip,
    });
    return (await repo.obtenerPaciente(cliente, id))!;
  });
}

/** Baja lógica: el paciente conserva consultas y archivos. */
export function darDeBaja(pool: pg.Pool, actor: Actor, id: number) {
  return cambiarActivo(pool, actor, id, false);
}

export function reactivar(pool: pg.Pool, actor: Actor, id: number) {
  return cambiarActivo(pool, actor, id, true);
}
