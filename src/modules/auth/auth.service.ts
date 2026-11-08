import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { SEGURIDAD } from '../../config/seguridad.js';
import { conTransaccion } from '../../db/tx.js';
import { AppError, errores } from '../../errors.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import * as repo from './auth.repo.js';
import type { UsuarioPublico } from './auth.types.js';
import { hashearPassword, obtenerHashRelleno, verificarPassword } from './password.js';

export function hashDeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const credencialesInvalidas = () =>
  new AppError(401, 'CREDENCIALES_INVALIDAS', 'Credenciales inválidas');

export interface ContextoPeticion {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Inicia sesión. Ante cualquier fallo (usuario inexistente, inactivo, bloqueado o contraseña
 * incorrecta) responde lo mismo y siempre ejecuta una verificación argon2, para no filtrar
 * información por el mensaje ni por el tiempo de respuesta.
 */
export async function iniciarSesion(
  pool: pg.Pool,
  datos: { nombre_usuario: string; password: string },
  contexto: ContextoPeticion,
): Promise<{ token: string; usuario: repo.UsuarioConCredenciales }> {
  const usuario = await repo.buscarParaLogin(pool, datos.nombre_usuario);
  const hash = usuario?.password_hash ?? (await obtenerHashRelleno());
  const passwordCorrecta = await verificarPassword(hash, datos.password);

  if (!usuario || !usuario.activo || usuario.bloqueado || !passwordCorrecta) {
    let motivo = 'credenciales';
    let bloqueoAplicado = false;
    if (!usuario) motivo = 'usuario_inexistente';
    else if (!usuario.activo) motivo = 'usuario_inactivo';
    else if (usuario.bloqueado) motivo = 'usuario_bloqueado';
    else {
      const resultado = await repo.registrarIntentoFallido(
        pool,
        usuario.id,
        SEGURIDAD.LOGIN_MAX_INTENTOS,
        SEGURIDAD.LOGIN_BLOQUEO_MINUTOS,
      );
      bloqueoAplicado = resultado.bloqueado;
    }
    await registrarAuditoria(pool, {
      idUsuario: usuario?.id ?? null,
      accion: 'login_fallido',
      entidad: usuario ? 'usuario' : undefined,
      entidadId: usuario?.id,
      ip: contexto.ip,
      // Nunca se guarda lo que se tipeó: podría ser una contraseña en el campo de usuario
      detalle: { motivo, ...(bloqueoAplicado ? { bloqueo_aplicado: true } : {}) },
    });
    throw credencialesInvalidas();
  }

  const token = randomBytes(32).toString('base64url');
  await conTransaccion(pool, async (cliente) => {
    await repo.registrarLoginExitoso(cliente, usuario.id);
    await repo.limpiarSesionesInactivas(cliente, usuario.id);
    await repo.crearSesion(cliente, {
      idUsuario: usuario.id,
      tokenHash: hashDeToken(token),
      duracionHoras: SEGURIDAD.SESION_DURACION_HORAS,
      ip: contexto.ip,
      userAgent: contexto.userAgent?.slice(0, 255) ?? null,
    });
    await registrarAuditoria(cliente, {
      idUsuario: usuario.id,
      accion: 'login_ok',
      entidad: 'usuario',
      entidadId: usuario.id,
      ip: contexto.ip,
    });
  });
  return { token, usuario };
}

export async function cerrarSesion(
  pool: pg.Pool,
  usuarioId: number,
  sesionId: number,
  ip: string | null,
): Promise<void> {
  await conTransaccion(pool, async (cliente) => {
    await repo.revocarSesion(cliente, sesionId);
    await registrarAuditoria(cliente, {
      idUsuario: usuarioId,
      accion: 'logout',
      entidad: 'usuario',
      entidadId: usuarioId,
      ip,
    });
  });
}

export async function cambiarPassword(
  pool: pg.Pool,
  usuarioId: number,
  sesionId: number,
  datos: { actual: string; nueva: string },
  ip: string | null,
): Promise<UsuarioPublico> {
  const usuario = await repo.buscarConCredencialesPorId(pool, usuarioId);
  if (!usuario) throw errores.noAutenticado();

  if (!(await verificarPassword(usuario.password_hash, datos.actual))) {
    throw errores.reglaDeNegocio(
      'PASSWORD_ACTUAL_INCORRECTA',
      'La contraseña actual es incorrecta',
    );
  }
  if (datos.actual === datos.nueva) {
    throw errores.reglaDeNegocio(
      'PASSWORD_REPETIDA',
      'La contraseña nueva debe ser distinta de la actual',
    );
  }

  const hashNuevo = await hashearPassword(datos.nueva);
  return conTransaccion(pool, async (cliente) => {
    await repo.actualizarPassword(cliente, usuarioId, hashNuevo, false);
    // Cierra el resto de las sesiones (por ejemplo, las de un posible intruso)
    await repo.revocarSesionesDeUsuario(cliente, usuarioId, sesionId);
    await registrarAuditoria(cliente, {
      idUsuario: usuarioId,
      accion: 'cambio_password',
      entidad: 'usuario',
      entidadId: usuarioId,
      ip,
    });
    return (await repo.obtenerUsuarioPublico(cliente, usuarioId))!;
  });
}
