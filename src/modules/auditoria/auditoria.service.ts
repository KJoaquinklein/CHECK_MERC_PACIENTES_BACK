import type { Request } from 'express';
import type { Ejecutor } from '../../db/pool.js';

/** Acciones de auditoría (sección 7.8 del plan). Es la lista oficial: no se registran otras. */
export const ACCIONES_AUDITORIA = [
  'login_ok',
  'login_fallido',
  'logout',
  'cambio_password',
  'usuario_crear',
  'usuario_editar',
  'usuario_desactivar',
  'usuario_reset_password',
  'paciente_crear',
  'ver_paciente',
  'paciente_editar',
  'paciente_baja',
  'paciente_reactivar',
  'consulta_crear',
  'ver_consulta',
  'consulta_editar',
  'consulta_cambiar_fecha',
  'consulta_anular',
  'consulta_restaurar',
  'archivo_subir',
  'ver_archivo',
  'archivo_editar',
  'archivo_baja',
  'archivo_restaurar',
  'auditoria_ver',
] as const;

export type AccionAuditoria = (typeof ACCIONES_AUDITORIA)[number];

export interface RegistroAuditoria {
  idUsuario?: number | null;
  accion: AccionAuditoria;
  entidad?: string;
  entidadId?: number;
  ip?: string | null;
  /** Ids y nombres de campos; nunca texto clínico ni contraseñas. */
  detalle?: Record<string, unknown>;
}

/**
 * Inserta un registro de auditoría. Recibe el ejecutor (pool o cliente de transacción) para que
 * los cambios puedan escribir su auditoría en la misma transacción.
 */
export async function registrarAuditoria(db: Ejecutor, registro: RegistroAuditoria): Promise<void> {
  await db.query(
    `INSERT INTO auditoria (id_usuario, accion, entidad, entidad_id, ip, detalle)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      registro.idUsuario ?? null,
      registro.accion,
      registro.entidad ?? null,
      registro.entidadId ?? null,
      registro.ip ?? null,
      registro.detalle ? JSON.stringify(registro.detalle) : null,
    ],
  );
}

/** IP del cliente (respeta `trust proxy`), sin el prefijo IPv4-mapeado. */
export function ipDe(req: Request): string | null {
  return req.ip ? req.ip.replace(/^::ffff:/, '') : null;
}
