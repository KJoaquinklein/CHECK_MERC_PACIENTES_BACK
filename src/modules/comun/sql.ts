import { z } from 'zod';

/** Escapa `\`, `%` y `_` del texto del usuario para usarlo en un LIKE ... ESCAPE '\'. */
export function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (caracter) => `\\${caracter}`);
}

/** Código de error de PostgreSQL para violación de unicidad. */
export function esViolacionUnicidad(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

export const esquemaId = z.coerce
  .number({ error: 'El id debe ser un número' })
  .int('El id debe ser un entero')
  .positive('El id debe ser positivo')
  .max(Number.MAX_SAFE_INTEGER);

export const esquemaParamsId = z.strictObject({ id: esquemaId });

export const esquemaBooleanoQuery = z
  .enum(['true', 'false'], { error: 'debe ser "true" o "false"' })
  .transform((valor) => valor === 'true');

export function esquemaPaginacion(maxPageSize = 100) {
  return {
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(maxPageSize).default(25),
  };
}

export const esquemaDireccion = z.enum(['asc', 'desc']).default('asc');

export interface RespuestaPaginada<T> {
  data: T[];
  meta: { page: number; page_size: number; total: number };
}

export function respuestaPaginada<T>(
  data: T[],
  page: number,
  pageSize: number,
  total: number,
): RespuestaPaginada<T> {
  return { data, meta: { page, page_size: pageSize, total } };
}

/** Nombre de la restricción violada en un error de unicidad de PostgreSQL. */
export function restriccionViolada(error: unknown): string | undefined {
  return (error as { constraint?: string } | null)?.constraint;
}

/** Fecha calendario `YYYY-MM-DD` (existente, ej. rechaza 2024-02-30). */
export const esquemaFecha = z.iso.date({ error: 'La fecha debe tener el formato AAAA-MM-DD' });

/** Texto opcional: se recorta; un texto vacío o null se guarda como null. */
export function textoOpcional(maximo: number, nombre: string) {
  return z
    .string({ error: `${nombre} debe ser texto` })
    .trim()
    .max(maximo, `${nombre} no puede superar los ${maximo} caracteres`)
    .transform((valor) => (valor === '' ? null : valor))
    .nullable();
}
