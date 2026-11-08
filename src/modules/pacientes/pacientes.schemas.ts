import { z } from 'zod';
import {
  esquemaDireccion,
  esquemaFecha,
  esquemaId,
  esquemaPaginacion,
  textoOpcional,
} from '../comun/sql.js';

/** DNI: se quitan puntos, espacios y guiones; quedan solo dígitos (6 a 9). */
const esquemaDni = z
  .string({ error: 'El DNI debe ser texto' })
  .transform((valor) => valor.replace(/[\s.-]/g, ''))
  .pipe(z.string().regex(/^\d{6,9}$/, 'El DNI debe tener entre 6 y 9 dígitos'));

const esquemaNombreCompleto = z
  .string({ error: 'El nombre completo es obligatorio' })
  .trim()
  .min(1, 'El nombre completo no puede estar vacío')
  .max(200, 'El nombre completo no puede superar los 200 caracteres');

const esquemaFechaNacimiento = esquemaFecha.refine(
  (fecha) => fecha >= '1900-01-01' && fecha <= new Date().toISOString().slice(0, 10),
  'La fecha de nacimiento debe estar entre 1900 y hoy',
);

const esquemaEmail = z
  .string({ error: 'El email debe ser texto' })
  .trim()
  .max(200, 'El email no puede superar los 200 caracteres')
  .transform((valor) => (valor === '' ? null : valor))
  .pipe(z.email('El email no es válido').nullable())
  .nullable();

const camposOpcionales = {
  fecha_nacimiento: esquemaFechaNacimiento.nullable(),
  telefono: textoOpcional(50, 'El teléfono'),
  email: esquemaEmail,
  domicilio: textoOpcional(300, 'El domicilio'),
  id_obra_social: esquemaId.nullable(),
  nro_afiliado: textoOpcional(50, 'El número de afiliado'),
  observaciones: textoOpcional(5000, 'Las observaciones'),
};

/** Alta rápida: solo `nombre_completo` es obligatorio. */
export const esquemaCrearPaciente = z.strictObject({
  nombre_completo: esquemaNombreCompleto,
  dni: esquemaDni.nullable().optional(),
  fecha_nacimiento: camposOpcionales.fecha_nacimiento.optional(),
  telefono: camposOpcionales.telefono.optional(),
  email: camposOpcionales.email.optional(),
  domicilio: camposOpcionales.domicilio.optional(),
  id_obra_social: camposOpcionales.id_obra_social.optional(),
  nro_afiliado: camposOpcionales.nro_afiliado.optional(),
  observaciones: camposOpcionales.observaciones.optional(),
});

/**
 * Edición parcial. El DNI se puede corregir pero no borrar: es el dato que identifica al
 * paciente, y una vez cargado no debe perderse por error.
 */
export const esquemaEditarPaciente = z
  .strictObject({
    nombre_completo: esquemaNombreCompleto,
    dni: esquemaDni,
    ...camposOpcionales,
  })
  .partial()
  .refine((datos) => Object.keys(datos).length > 0, 'Indicá al menos un campo para modificar');

export const ORDENES_PACIENTE = ['nombre', 'dni', 'creado_en', 'ultima_consulta'] as const;

const filtrosPaciente = {
  q: z.string().trim().max(100).optional(),
  id_obra_social: esquemaId.optional(),
  activo: z.enum(['true', 'false', 'todos']).default('true'),
  creado_desde: esquemaFecha.optional(),
  creado_hasta: esquemaFecha.optional(),
};

const rangoCreadoValido = (datos: { creado_desde?: string; creado_hasta?: string }) =>
  !datos.creado_desde || !datos.creado_hasta || datos.creado_desde <= datos.creado_hasta;
const mensajeRango = 'creado_desde no puede ser posterior a creado_hasta';

export const esquemaListarPacientes = z
  .strictObject({
    ...filtrosPaciente,
    orden: z.enum(ORDENES_PACIENTE).default('nombre'),
    dir: esquemaDireccion,
    ...esquemaPaginacion(100),
  })
  .refine(rangoCreadoValido, mensajeRango);

/** El conteo acepta exactamente los mismos filtros que el listado, sin orden ni paginación. */
export const esquemaConteoPacientes = z
  .strictObject(filtrosPaciente)
  .refine(rangoCreadoValido, mensajeRango);

export type ListarPacientes = z.infer<typeof esquemaListarPacientes>;
export type FiltrosPacientes = z.infer<typeof esquemaConteoPacientes>;
