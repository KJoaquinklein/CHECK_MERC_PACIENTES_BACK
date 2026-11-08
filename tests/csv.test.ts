import { describe, expect, it } from 'vitest';
import { aCsv, neutralizarFormula } from '../src/modules/comun/csv.js';

describe('neutralizarFormula', () => {
  it('antepone un apóstrofo al texto que una planilla ejecutaría como fórmula', () => {
    for (const peligroso of [
      '=1+1',
      '+54 351 555',
      '-2+3',
      '@SUM(A1)',
      '\tcmd',
      '\rcmd',
      '  =HYPERLINK("http://malo","click")',
      ' @x',
    ]) {
      expect(neutralizarFormula(peligroso), JSON.stringify(peligroso)).toBe(`'${peligroso}`);
    }
  });

  it('deja intacto el texto normal', () => {
    for (const normal of ['Ana Pérez', '2024-03-01', 'a=b', 'ana-maria', 'x@y.com', '', '100%']) {
      expect(neutralizarFormula(normal)).toBe(normal);
    }
  });
});

describe('aCsv', () => {
  it('genera UTF-8 con BOM, encabezado, separador ; y líneas CRLF', () => {
    const csv = aCsv(['mes', 'consultas'], [{ mes: '2024-03-01', consultas: 5 }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿mes;consultas\r\n2024-03-01;5\r\n');
  });

  it('respeta el separador configurado', () => {
    expect(aCsv(['a', 'b'], [{ a: 1, b: 2 }], ',')).toBe('﻿a,b\r\n1,2\r\n');
  });

  it('neutraliza las fórmulas en texto pero no toca los números, ni siquiera los negativos', () => {
    const csv = aCsv(
      ['nombre', 'valor'],
      [
        { nombre: '=cmd|"/c calc"!A1', valor: -5 },
        { nombre: '+1', valor: 0 },
        { nombre: '-1', valor: 1.5 },
        { nombre: '@SUMA(1)', valor: null },
      ],
    );
    const filas = csv.slice(1).split('\r\n');
    expect(filas[1]).toBe(`"'=cmd|""/c calc""!A1";-5`);
    expect(filas[2]).toBe("'+1;0");
    expect(filas[3]).toBe("'-1;1.5");
    expect(filas[4]).toBe("'@SUMA(1);");
  });

  it('entrecomilla las celdas con separador, comillas o saltos de línea', () => {
    const csv = aCsv(['t'], [{ t: 'a;b' }, { t: 'dijo "hola"' }, { t: 'línea1\nlínea2' }]);
    expect(csv).toBe('﻿t\r\n"a;b"\r\n"dijo ""hola"""\r\n"línea1\nlínea2"\r\n');
  });

  it('formatea nulos, booleanos y fechas', () => {
    const csv = aCsv(['a', 'b', 'c'], [{ a: null, b: true, c: new Date('2024-05-10T18:30:00Z') }]);
    expect(csv).toBe('﻿a;b;c\r\n;true;2024-05-10T18:30:00.000Z\r\n');
  });

  it('con filas vacías devuelve solo el encabezado', () => {
    expect(aCsv(['x', 'y'], [])).toBe('﻿x;y\r\n');
  });
});
