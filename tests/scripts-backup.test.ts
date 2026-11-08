import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Estos tests prueban la LÓGICA de los scripts de backup y restauración (armado de la conexión,
 * seguridad de la contraseña, retención, verificaciones previas) con versiones simuladas de
 * pg_dump / pg_restore / psql. No prueban pg_dump en sí: ver DECISIONES.md (Fase 7).
 */
const hayBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const aPosix = (ruta: string) => ruta.replaceAll('\\', '/');

const STUB_PG_DUMP = `#!/usr/bin/env bash
echo "pg_dump $*" >> "$STUB_LOG"
echo "ENV PGUSER=$PGUSER PGPASSWORD=$PGPASSWORD PGHOST=$PGHOST PGPORT=$PGPORT PGDATABASE=$PGDATABASE PGSSLMODE=\${PGSSLMODE:-}" >> "$STUB_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = "--file" ]; then echo "contenido de la copia" > "$2"; fi
  shift
done
exit \${STUB_PG_DUMP_EXIT:-0}
`;

const STUB_PG_RESTORE = `#!/usr/bin/env bash
echo "pg_restore $*" >> "$STUB_LOG"
echo "ENV PGUSER=$PGUSER PGPASSWORD=$PGPASSWORD PGHOST=$PGHOST PGDATABASE=$PGDATABASE" >> "$STUB_LOG"
case " $* " in *" --list "*) exit \${STUB_LIST_EXIT:-0} ;; esac
exit \${STUB_RESTORE_EXIT:-0}
`;

const STUB_PSQL = `#!/usr/bin/env bash
echo "psql $*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = "--command" ]; then consulta="$2"; fi
  shift
done
case "$consulta" in
  *pg_tables*) echo "\${STUB_TABLAS:-0}" ;;
  *pg_roles*) echo "\${STUB_ROL:-1}" ;;
  *) echo "7" ;;
esac
`;

describe.skipIf(!hayBash)('scripts de backup y restauración (herramientas simuladas)', () => {
  const raiz = process.cwd();
  let carpetaStubs: string;
  let carpetaTrabajo: string;
  let log: string;

  beforeAll(() => {
    carpetaStubs = mkdtempSync(path.join(os.tmpdir(), 'hc-stubs-'));
    for (const [nombre, contenido] of [
      ['pg_dump', STUB_PG_DUMP],
      ['pg_restore', STUB_PG_RESTORE],
      ['psql', STUB_PSQL],
    ] as const) {
      writeFileSync(path.join(carpetaStubs, nombre), contenido, { mode: 0o755 });
    }
  });
  afterAll(() => rmSync(carpetaStubs, { recursive: true, force: true }));
  beforeEach(() => {
    carpetaTrabajo = mkdtempSync(path.join(os.tmpdir(), 'hc-backup-'));
    log = path.join(carpetaTrabajo, 'llamadas.log');
    writeFileSync(log, '');
  });

  function ejecutar(script: string, argumentos: string[], entorno: Record<string, string> = {}) {
    const resultado = spawnSync('bash', [script, ...argumentos], {
      cwd: raiz,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${carpetaStubs}${path.delimiter}${process.env.PATH}`,
        STUB_LOG: aPosix(log),
        // Solo las variables que fija cada caso: no se hereda ninguna conexión real
        BACKUP_DATABASE_URL: '',
        MIGRATIONS_DATABASE_URL: '',
        RESTORE_DATABASE_URL: '',
        ...entorno,
      },
    });
    return {
      estado: resultado.status,
      salida: resultado.stdout,
      error: resultado.stderr,
      llamadas: readFileSync(log, 'utf8'),
    };
  }

  describe('lib-postgres.sh: exportar_conexion', () => {
    const analizar = (url: string) => {
      const r = spawnSync(
        'bash',
        [
          '-c',
          'source scripts/lib-postgres.sh; exportar_conexion "$1" && echo "$PGUSER|$PGPASSWORD|$PGHOST|$PGPORT|$PGDATABASE|${PGSSLMODE:-}"',
          '_',
          url,
        ],
        { cwd: raiz, encoding: 'utf8', env: { ...process.env, PGSSLMODE: '' } },
      );
      return { estado: r.status, salida: r.stdout.trim(), error: r.stderr };
    };

    it('descompone la URL y decodifica los caracteres especiales de la contraseña', () => {
      expect(
        analizar('postgres://hc_migrator:p%40ss%2Fw%3Dx@dpg-abc.render.com/gestor?sslmode=require')
          .salida,
      ).toBe('hc_migrator|p@ss/w=x|dpg-abc.render.com|5432|gestor|require');
      expect(analizar('postgresql://u:clave@db.interno:6543/mi_base').salida).toBe(
        'u|clave|db.interno|6543|mi_base|require',
      );
    });

    it('exige SSL salvo en la propia máquina, y respeta el sslmode de la URL', () => {
      expect(analizar('postgres://u:c@localhost:5433/x').salida).toBe('u|c|localhost|5433|x|');
      expect(analizar('postgres://u:c@127.0.0.1/x').salida).toBe('u|c|127.0.0.1|5432|x|');
      expect(analizar('postgres://u:c@host/x?application_name=a&sslmode=verify-full').salida).toBe(
        'u|c|host|5432|x|verify-full',
      );
    });

    it('rechaza URLs que no son de PostgreSQL o están incompletas', () => {
      for (const url of [
        'mysql://u:c@h/db',
        'postgres://host/db',
        'postgres://u:c@host',
        'texto suelto',
        '',
      ]) {
        const r = analizar(url);
        expect(r.estado, url).toBe(1);
      }
    });
  });

  describe('backup.sh', () => {
    const URL = 'postgres://hc_migrator:secreto%2FPG@dpg-abc.render.com:5432/gestor';

    it('genera la copia y su SHA-256, sin exponer la contraseña en los argumentos', () => {
      const destino = path.join(carpetaTrabajo, 'copias');
      const r = ejecutar('scripts/backup.sh', [aPosix(destino)], { MIGRATIONS_DATABASE_URL: URL });
      expect(r.estado, r.error).toBe(0);

      const archivos = readdirSync(destino);
      const copia = archivos.find((nombre) => nombre.endsWith('.dump'))!;
      expect(copia).toMatch(/^historias-clinicas-\d{8}T\d{6}Z\.dump$/);
      expect(archivos).toContain(`${copia}.sha256`);
      expect(archivos.some((nombre) => nombre.endsWith('.parcial'))).toBe(false);

      const huella = createHash('sha256')
        .update(readFileSync(path.join(destino, copia)))
        .digest('hex');
      expect(readFileSync(path.join(destino, `${copia}.sha256`), 'utf8').trim()).toBe(
        `${huella}  ${copia}`,
      );

      const [comandoPgDump, entorno] = r.llamadas.split('\n');
      expect(comandoPgDump).toContain('--format=custom');
      expect(comandoPgDump).toContain('--no-owner');
      expect(comandoPgDump).not.toContain('secreto');
      expect(comandoPgDump).not.toContain('postgres://');
      expect(entorno).toBe(
        'ENV PGUSER=hc_migrator PGPASSWORD=secreto/PG PGHOST=dpg-abc.render.com PGPORT=5432 PGDATABASE=gestor PGSSLMODE=require',
      );
      expect(r.salida).toContain('Copia lista');
      expect(r.salida).toContain(huella);
    });

    it('BACKUP_DATABASE_URL tiene prioridad sobre MIGRATIONS_DATABASE_URL', () => {
      const r = ejecutar('scripts/backup.sh', [aPosix(carpetaTrabajo)], {
        MIGRATIONS_DATABASE_URL: 'postgres://migrador:x@host-a/base_a',
        BACKUP_DATABASE_URL: 'postgres://respaldo:x@host-b/base_b',
      });
      expect(r.estado, r.error).toBe(0);
      expect(r.llamadas).toContain('PGUSER=respaldo');
      expect(r.llamadas).toContain('PGDATABASE=base_b');
    });

    it('falla con un mensaje claro si falta la conexión o la retención es inválida', () => {
      const sinUrl = ejecutar('scripts/backup.sh', [aPosix(carpetaTrabajo)]);
      expect(sinUrl.estado).toBe(1);
      expect(sinUrl.error).toContain('Falta BACKUP_DATABASE_URL');

      const retencion = ejecutar('scripts/backup.sh', [aPosix(carpetaTrabajo)], {
        BACKUP_DATABASE_URL: URL,
        BACKUP_RETENCION_DIAS: 'abc',
      });
      expect(retencion.estado).toBe(1);
      expect(retencion.error).toContain('BACKUP_RETENCION_DIAS');
      expect(retencion.llamadas).toBe('');
    });

    it('borra solo las copias más viejas que la retención', () => {
      const destino = path.join(carpetaTrabajo, 'copias');
      mkdirSync(destino);
      const crear = (nombre: string, diasAtras: number) => {
        const ruta = path.join(destino, nombre);
        writeFileSync(ruta, 'x');
        const fecha = new Date(Date.now() - diasAtras * 86_400_000);
        utimesSync(ruta, fecha, fecha);
      };
      crear('historias-clinicas-20200101T000000Z.dump', 40);
      crear('historias-clinicas-20200101T000000Z.dump.sha256', 40);
      crear('historias-clinicas-20251101T000000Z.dump', 1);
      crear('otro-archivo-viejo.dump', 400);

      const r = ejecutar('scripts/backup.sh', [aPosix(destino)], {
        BACKUP_DATABASE_URL: URL,
        BACKUP_RETENCION_DIAS: '30',
      });
      expect(r.estado, r.error).toBe(0);
      const quedan = readdirSync(destino);
      expect(quedan).not.toContain('historias-clinicas-20200101T000000Z.dump');
      expect(quedan).not.toContain('historias-clinicas-20200101T000000Z.dump.sha256');
      expect(quedan).toContain('historias-clinicas-20251101T000000Z.dump');
      expect(quedan).toContain('otro-archivo-viejo.dump');
      expect(quedan.filter((nombre) => nombre.endsWith('.dump')).length).toBe(3);
    });

    it('si pg_dump falla o la copia queda dañada, no deja archivos a medias', () => {
      const fallas: Record<string, string>[] = [
        { STUB_PG_DUMP_EXIT: '1' },
        { STUB_LIST_EXIT: '1' },
      ];
      for (const entorno of fallas) {
        const destino = path.join(carpetaTrabajo, `copias-${Object.keys(entorno)[0]}`);
        const r = ejecutar('scripts/backup.sh', [aPosix(destino)], {
          BACKUP_DATABASE_URL: URL,
          ...entorno,
        });
        expect(r.estado, JSON.stringify(entorno)).toBe(1);
        expect(readdirSync(destino)).toEqual([]);
      }
    });
  });

  describe('restaurar.sh', () => {
    const URL = 'postgres://hc_migrator:otra%2Bclave@host-nuevo.render.com/gestor_nueva';

    /** Crea una copia con su SHA-256 correcto. */
    function crearCopia(contenido = 'datos de la copia') {
      const archivo = path.join(carpetaTrabajo, 'copia.dump');
      writeFileSync(archivo, contenido);
      const huella = createHash('sha256').update(contenido).digest('hex');
      writeFileSync(`${archivo}.sha256`, `${huella}  copia.dump\n`);
      return aPosix(archivo);
    }
    const restauraciones = (llamadas: string) =>
      llamadas
        .split('\n')
        .filter((linea) => linea.startsWith('pg_restore') && !linea.includes('--list'));

    it('verifica la integridad, comprueba el destino y restaura todo o nada', () => {
      const r = ejecutar('scripts/restaurar.sh', [crearCopia()], { RESTORE_DATABASE_URL: URL });
      expect(r.estado, r.error).toBe(0);
      expect(r.salida).toContain('Integridad verificada');

      const [restauracion] = restauraciones(r.llamadas);
      expect(restauracion).toContain('--no-owner');
      expect(restauracion).toContain('--exit-on-error');
      expect(restauracion).toContain('--single-transaction');
      expect(restauracion).toContain('--dbname gestor_nueva');
      // La contraseña solo viaja por el entorno (líneas ENV), nunca en los argumentos de un comando
      const comandos = r.llamadas.split('\n').filter((linea) => !linea.startsWith('ENV'));
      expect(comandos.join('\n')).not.toContain('otra+clave');
      expect(r.llamadas).toContain('PGPASSWORD=otra+clave');
      expect(r.salida).toContain('Filas por tabla');
      expect(r.salida).toMatch(/paciente\s+7/);
    });

    it('se niega si la copia fue alterada (SHA-256 distinto)', () => {
      const archivo = crearCopia();
      writeFileSync(archivo, 'contenido alterado');
      const r = ejecutar('scripts/restaurar.sh', [archivo], { RESTORE_DATABASE_URL: URL });
      expect(r.estado).toBe(1);
      expect(r.error).toContain('SHA-256');
      expect(restauraciones(r.llamadas)).toEqual([]);
    });

    it('se niega a restaurar sobre una base que ya tiene tablas', () => {
      const r = ejecutar('scripts/restaurar.sh', [crearCopia()], {
        RESTORE_DATABASE_URL: URL,
        STUB_TABLAS: '4',
      });
      expect(r.estado).toBe(1);
      expect(r.error).toContain('ya tiene 4 tabla');
      expect(restauraciones(r.llamadas)).toEqual([]);
    });

    it('avisa si falta el rol hc_app (hay que ejecutar crear-roles antes)', () => {
      const r = ejecutar('scripts/restaurar.sh', [crearCopia()], {
        RESTORE_DATABASE_URL: URL,
        STUB_ROL: '0',
      });
      expect(r.estado).toBe(1);
      expect(r.error).toContain('crear-roles');
      expect(restauraciones(r.llamadas)).toEqual([]);
    });

    it('sin archivo .sha256 avisa pero continúa; con argumentos inválidos falla', () => {
      const archivo = crearCopia();
      rmSync(`${archivo}.sha256`);
      const sinHuella = ejecutar('scripts/restaurar.sh', [archivo], { RESTORE_DATABASE_URL: URL });
      expect(sinHuella.estado, sinHuella.error).toBe(0);
      expect(sinHuella.error).toContain('no hay archivo .sha256');

      expect(ejecutar('scripts/restaurar.sh', [], { RESTORE_DATABASE_URL: URL }).estado).toBe(1);
      expect(
        ejecutar('scripts/restaurar.sh', ['/no/existe.dump'], { RESTORE_DATABASE_URL: URL }).estado,
      ).toBe(1);
      const sinUrl = ejecutar('scripts/restaurar.sh', [archivo]);
      expect(sinUrl.estado).toBe(1);
      expect(sinUrl.error).toContain('RESTORE_DATABASE_URL');
    });

    it('si pg_restore falla, el script termina con error y no informa éxito', () => {
      const r = ejecutar('scripts/restaurar.sh', [crearCopia()], {
        RESTORE_DATABASE_URL: URL,
        STUB_RESTORE_EXIT: '1',
      });
      expect(r.estado).not.toBe(0);
      expect(r.salida).not.toContain('Restauración terminada');
      expect(existsSync(carpetaTrabajo)).toBe(true);
    });
  });
});
