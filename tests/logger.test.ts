import { describe, expect, it } from 'vitest';
import { crearLogger, serializarError } from '../src/config/logger.js';

/** Error con la forma de los que lanza `pg` (el campo `detail` trae los valores del dato). */
function errorDePostgres() {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "paciente_dni_uk"'),
    {
      code: '23505',
      constraint: 'paciente_dni_uk',
      table: 'paciente',
      detail: 'Key (dni)=(30123456) already exists.',
      where: 'valor sensible en el contexto',
      hint: 'otra pista con datos',
      internalQuery: "SELECT * FROM paciente WHERE nombre = 'Ana Pérez'",
    },
  );
}

describe('registro de errores', () => {
  it('conserva lo útil para diagnosticar y descarta los valores de los datos', () => {
    const serializado = serializarError(errorDePostgres());
    expect(serializado).toMatchObject({
      type: 'Error',
      code: '23505',
      constraint: 'paciente_dni_uk',
      table: 'paciente',
      message: expect.stringContaining('paciente_dni_uk'),
    });
    expect(Object.keys(serializado)).not.toEqual(expect.arrayContaining(['detail']));
    const texto = JSON.stringify(serializado);
    for (const sensible of ['30123456', 'Ana Pérez', 'valor sensible', 'otra pista']) {
      expect(texto).not.toContain(sensible);
    }
  });

  it('el logger real escribe el error depurado', () => {
    const lineas: string[] = [];
    const logger = crearLogger(
      { NODE_ENV: 'production', LOG_LEVEL: 'info' },
      { write: (linea: string) => void lineas.push(linea) },
    );
    logger.error({ err: errorDePostgres() }, 'Error interno no controlado');
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toContain('paciente_dni_uk');
    expect(lineas[0]).not.toContain('30123456');
    expect(lineas[0]).not.toContain('Ana Pérez');
  });

  it('oculta cookies y credenciales si alguna vez llegan a un registro', () => {
    const lineas: string[] = [];
    const logger = crearLogger(
      { NODE_ENV: 'production', LOG_LEVEL: 'info' },
      { write: (linea: string) => void lineas.push(linea) },
    );
    logger.info(
      { req: { headers: { cookie: 'sid=secreto', authorization: 'Bearer secreto' } } },
      'x',
    );
    expect(lineas[0]).not.toContain('secreto');
  });
});
