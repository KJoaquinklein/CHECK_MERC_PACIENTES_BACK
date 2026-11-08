import type pg from 'pg';
import { conTransaccion } from '../../db/tx.js';
import { errores } from '../../errors.js';
import { registrarAuditoria, type AccionAuditoria } from '../auditoria/auditoria.service.js';
import * as authRepo from '../auth/auth.repo.js';
import type { Rol, UsuarioPublico } from '../auth/auth.types.js';
import { hashearPassword } from '../auth/password.js';
import { esViolacionUnicidad, respuestaPaginada } from '../comun/sql.js';
import * as repo from './usuarios.repo.js';

/** Quién hace el cambio y desde dónde (para las reglas y la auditoría). */
export interface Actor {
  id: number;
  ip: string | null;
}

export async function listar(pool: pg.Pool, filtros: repo.FiltrosUsuarios) {
  const { filas, total } = await repo.listarUsuarios(pool, filtros);
  return respuestaPaginada(filas, filtros.page, filtros.page_size, total);
}

export async function obtener(pool: pg.Pool, id: number): Promise<UsuarioPublico> {
  const usuario = await authRepo.obtenerUsuarioPublico(pool, id);
  if (!usuario) throw errores.noEncontrado('El usuario no existe');
  return usuario;
}

export async function crear(
  pool: pg.Pool,
  actor: Actor,
  datos: { nombre_usuario: string; nombre_completo: string; rol: Rol; password_temporal: string },
): Promise<UsuarioPublico> {
  const passwordHash = await hashearPassword(datos.password_temporal);
  try {
    return await conTransaccion(pool, async (cliente) => {
      const usuario = await repo.crearUsuario(cliente, {
        nombre_usuario: datos.nombre_usuario,
        nombre_completo: datos.nombre_completo,
        rol: datos.rol,
        password_hash: passwordHash,
      });
      await registrarAuditoria(cliente, {
        idUsuario: actor.id,
        accion: 'usuario_crear',
        entidad: 'usuario',
        entidadId: usuario.id,
        ip: actor.ip,
        detalle: { rol: usuario.rol },
      });
      return usuario;
    });
  } catch (error) {
    if (esViolacionUnicidad(error)) {
      throw errores.conflicto(
        'USUARIO_DUPLICADO',
        'Ya existe un usuario con ese nombre de usuario',
      );
    }
    throw error;
  }
}

/**
 * Edita rol, nombre y estado de un usuario. Reglas (sección 6, punto 10): nadie puede cambiar su
 * propio rol ni desactivarse, y siempre debe quedar al menos un administrador activo. Los
 * administradores activos se bloquean antes de decidir, para que dos cambios simultáneos no
 * puedan dejar el sistema sin administradores.
 */
export async function editar(
  pool: pg.Pool,
  actor: Actor,
  id: number,
  cambios: { nombre_completo?: string; rol?: Rol; activo?: boolean },
): Promise<UsuarioPublico> {
  return conTransaccion(pool, async (cliente) => {
    const administradores = await repo.bloquearAdministradoresActivos(cliente);
    const actual = await repo.bloquearUsuario(cliente, id);
    if (!actual) throw errores.noEncontrado('El usuario no existe');

    const modificados = (Object.keys(cambios) as (keyof typeof cambios)[]).filter(
      (campo) => cambios[campo] !== undefined && cambios[campo] !== actual[campo],
    );
    if (modificados.length === 0) return actual;

    const cambiaRol = modificados.includes('rol');
    const cambiaActivo = modificados.includes('activo');
    if (actor.id === id && (cambiaRol || cambiaActivo)) {
      throw errores.reglaDeNegocio(
        'AUTO_MODIFICACION',
        'No podés cambiar tu propio rol ni desactivarte a vos mismo',
      );
    }

    const dejaDeSerAdminActivo =
      actual.rol === 'admin' &&
      actual.activo &&
      ((cambiaRol && cambios.rol !== 'admin') || (cambiaActivo && cambios.activo === false));
    if (dejaDeSerAdminActivo && administradores.filter((adminId) => adminId !== id).length === 0) {
      throw errores.reglaDeNegocio('ULTIMO_ADMIN', 'Debe quedar al menos un administrador activo');
    }

    const actualizado = await repo.actualizarUsuario(cliente, id, cambios);
    const seDesactiva = cambiaActivo && cambios.activo === false;
    if (seDesactiva) await authRepo.revocarSesionesDeUsuario(cliente, id);

    const accion: AccionAuditoria = seDesactiva ? 'usuario_desactivar' : 'usuario_editar';
    await registrarAuditoria(cliente, {
      idUsuario: actor.id,
      accion,
      entidad: 'usuario',
      entidadId: id,
      ip: actor.ip,
      detalle: {
        campos: modificados,
        antes: Object.fromEntries(modificados.map((campo) => [campo, actual[campo]])),
        despues: Object.fromEntries(modificados.map((campo) => [campo, actualizado[campo]])),
      },
    });
    return actualizado;
  });
}

/** Baja lógica: desactiva al usuario y revoca todas sus sesiones. */
export function desactivar(pool: pg.Pool, actor: Actor, id: number): Promise<UsuarioPublico> {
  return editar(pool, actor, id, { activo: false });
}

export async function restablecerPassword(
  pool: pg.Pool,
  actor: Actor,
  id: number,
  passwordTemporal: string,
): Promise<UsuarioPublico> {
  if (actor.id === id) {
    throw errores.reglaDeNegocio(
      'AUTO_MODIFICACION',
      'Para cambiar tu propia contraseña usá "cambiar contraseña"',
    );
  }
  const passwordHash = await hashearPassword(passwordTemporal);
  return conTransaccion(pool, async (cliente) => {
    const usuario = await repo.bloquearUsuario(cliente, id);
    if (!usuario) throw errores.noEncontrado('El usuario no existe');

    await authRepo.actualizarPassword(cliente, id, passwordHash, true);
    await authRepo.revocarSesionesDeUsuario(cliente, id);
    await registrarAuditoria(cliente, {
      idUsuario: actor.id,
      accion: 'usuario_reset_password',
      entidad: 'usuario',
      entidadId: id,
      ip: actor.ip,
    });
    return (await authRepo.obtenerUsuarioPublico(cliente, id))!;
  });
}
