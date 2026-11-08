import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conTransaccion } from '../src/db/tx.js';
import {
  configBasePruebas,
  limpiarDatos,
  poolApp,
  poolMigrador,
  type ConfigBasePruebas,
} from './utilidades/db.js';

const config: ConfigBasePruebas | null = configBasePruebas();

describe.skipIf(!config)('integridad del esquema (PostgreSQL real)', () => {
  let app: pg.Pool;
  let migrador: pg.Pool;

  beforeAll(() => {
    app = poolApp(config!);
    migrador = poolMigrador(config!);
  });
  afterAll(async () => {
    await app.end();
    await migrador.end();
  });
  beforeEach(async () => {
    await limpiarDatos(migrador);
  });

  async function crearConsultaConAuditoria() {
    const paciente = await app.query(
      "INSERT INTO paciente (nombre_completo) VALUES ('Paciente de prueba') RETURNING id",
    );
    const consulta = await app.query(
      'INSERT INTO consulta (id_paciente) VALUES ($1) RETURNING id',
      [paciente.rows[0].id],
    );
    await app.query(
      "INSERT INTO consulta_contenido (id_consulta, version, contenido) VALUES ($1, 0, 'original')",
      [consulta.rows[0].id],
    );
    await app.query("INSERT INTO auditoria (accion) VALUES ('prueba')");
    return { idPaciente: paciente.rows[0].id as number, idConsulta: consulta.rows[0].id as number };
  }

  describe('solo inserción', () => {
    it('hc_app no puede modificar ni borrar consulta_contenido ni auditoria', async () => {
      await crearConsultaConAuditoria();
      await expect(app.query("UPDATE consulta_contenido SET contenido = 'x'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query('DELETE FROM consulta_contenido')).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query("UPDATE auditoria SET accion = 'x'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query('DELETE FROM auditoria')).rejects.toThrow(/permission denied/);
    });

    it('los triggers bloquean incluso al dueño del esquema', async () => {
      await crearConsultaConAuditoria();
      for (const sql of [
        "UPDATE consulta_contenido SET contenido = 'x'",
        'DELETE FROM consulta_contenido',
        "UPDATE auditoria SET accion = 'x'",
        'DELETE FROM auditoria',
      ]) {
        await expect(migrador.query(sql)).rejects.toThrow(/solo inserción/);
      }
    });

    it('hc_app puede insertar versiones nuevas, pero no repetir una versión', async () => {
      const { idConsulta } = await crearConsultaConAuditoria();
      await app.query(
        "INSERT INTO consulta_contenido (id_consulta, version, contenido) VALUES ($1, 1, 'editado')",
        [idConsulta],
      );
      await expect(
        app.query(
          "INSERT INTO consulta_contenido (id_consulta, version, contenido) VALUES ($1, 1, 'otra')",
          [idConsulta],
        ),
      ).rejects.toThrow(/duplicate key/);
      const vigente = await app.query(
        'SELECT version, contenido, fue_editada FROM consulta_actual WHERE id = $1',
        [idConsulta],
      );
      expect(vigente.rows[0]).toEqual({ version: 1, contenido: 'editado', fue_editada: true });
    });
  });

  describe('permisos de hc_app', () => {
    it('no puede borrar filas de ninguna tabla salvo sesion', async () => {
      const { rows } = await migrador.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'",
      );
      expect(rows.length).toBeGreaterThanOrEqual(8);
      for (const { tablename } of rows) {
        const consulta = app.query(`DELETE FROM ${tablename} WHERE false`);
        if (tablename === 'sesion') await expect(consulta).resolves.toBeDefined();
        else await expect(consulta).rejects.toThrow(/permission denied/);
      }
    });

    it('no puede ver la tabla de migraciones ni crear objetos', async () => {
      await expect(app.query('SELECT * FROM pgmigrations')).rejects.toThrow(/permission denied/);
      await expect(app.query('CREATE TABLE intruso (id int)')).rejects.toThrow(/permission denied/);
      await expect(app.query('TRUNCATE paciente')).rejects.toThrow(/permission denied/);
    });
  });

  describe('búsqueda', () => {
    it('"jose angel" encuentra a "José Ángel" (sin tildes ni mayúsculas)', async () => {
      await app.query(
        "INSERT INTO paciente (nombre_completo, dni) VALUES ('José Ángel Pérez', '30123456')",
      );
      await app.query("INSERT INTO paciente (nombre_completo) VALUES ('María López')");
      const { rows } = await app.query(
        "SELECT nombre_completo FROM paciente WHERE busqueda LIKE '%' || f_unaccent(lower($1)) || '%' ESCAPE '\\'",
        ['jose angel'],
      );
      expect(rows).toEqual([{ nombre_completo: 'José Ángel Pérez' }]);
    });

    it('el texto completo de consultas ignora tildes y variantes', async () => {
      const { idConsulta } = await crearConsultaConAuditoria();
      await app.query(
        "INSERT INTO consulta_contenido (id_consulta, version, contenido) VALUES ($1, 1, 'Paciente refiere dolores de cabeza frecuentes')",
        [idConsulta],
      );
      const { rows } = await app.query(
        "SELECT id FROM consulta_actual WHERE busqueda @@ plainto_tsquery('es_unaccent', $1)",
        ['dolor cabeza'],
      );
      expect(rows).toHaveLength(1);
    });

    it('el DNI es único entre pacientes que lo tienen, y puede faltar en varios', async () => {
      await app.query("INSERT INTO paciente (nombre_completo, dni) VALUES ('A', '12345678')");
      await expect(
        app.query("INSERT INTO paciente (nombre_completo, dni) VALUES ('B', '12345678')"),
      ).rejects.toThrow(/paciente_dni_uk/);
      await app.query("INSERT INTO paciente (nombre_completo) VALUES ('C')");
      await app.query("INSERT INTO paciente (nombre_completo) VALUES ('D')");
    });
  });

  describe('conTransaccion', () => {
    it('confirma si todo sale bien', async () => {
      await conTransaccion(app, async (c) => {
        await c.query("INSERT INTO obra_social (nombre) VALUES ('OSDE')");
      });
      const { rowCount } = await app.query('SELECT 1 FROM obra_social');
      expect(rowCount).toBe(1);
    });

    it('revierte todo si algo falla', async () => {
      await expect(
        conTransaccion(app, async (c) => {
          await c.query("INSERT INTO obra_social (nombre) VALUES ('OSDE')");
          throw new Error('falla a propósito');
        }),
      ).rejects.toThrow('falla a propósito');
      const { rowCount } = await app.query('SELECT 1 FROM obra_social');
      expect(rowCount).toBe(0);
    });
  });
});
