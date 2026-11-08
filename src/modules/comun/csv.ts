/** Marca de orden de bytes: hace que Excel interprete el archivo como UTF-8 (tildes y ñ). */
const BOM = '﻿';

/**
 * Excel (y otras planillas) ejecutan como fórmula las celdas de texto que empiezan con `=`, `+`,
 * `-` o `@`, o con tabulación / retorno de carro. También si hay espacios antes del signo.
 */
const EMPIEZA_COMO_FORMULA = /^(?:[\t\r]|\s*[=+\-@])/;

/** Antepone un apóstrofo al texto que una planilla interpretaría como fórmula. */
export function neutralizarFormula(texto: string): string {
  return EMPIEZA_COMO_FORMULA.test(texto) ? `'${texto}` : texto;
}

function aTexto(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  // Los números no son texto: un -5 legítimo no se toca
  if (typeof valor === 'number' || typeof valor === 'bigint') return String(valor);
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  if (valor instanceof Date) return valor.toISOString();
  return neutralizarFormula(String(valor));
}

function celda(valor: unknown, separador: string): string {
  const texto = aTexto(valor);
  const necesitaComillas = texto.includes(separador) || /["\r\n]/.test(texto);
  return necesitaComillas ? `"${texto.replaceAll('"', '""')}"` : texto;
}

/**
 * Genera un CSV en UTF-8 con BOM, líneas terminadas en CRLF y las celdas de texto
 * neutralizadas contra inyección de fórmulas.
 */
export function aCsv(
  columnas: readonly string[],
  filas: readonly Record<string, unknown>[],
  separador = ';',
): string {
  const lineas = [
    columnas.map((nombre) => celda(nombre, separador)).join(separador),
    ...filas.map((fila) =>
      columnas.map((nombre) => celda(fila[nombre], separador)).join(separador),
    ),
  ];
  return `${BOM}${lineas.join('\r\n')}\r\n`;
}
