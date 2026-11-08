import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';

const raiz = process.cwd();
const rutaSpec = path.join(raiz, 'openapi.yaml');
const METODOS = ['get', 'post', 'patch', 'delete'] as const;

interface Operacion {
  operationId?: string;
  parameters?: { $ref?: string; name?: string }[];
  responses?: Record<string, unknown>;
  security?: unknown[];
}
type ItemDeRuta = Record<string, Operacion | unknown>;

/** Rutas que declara el código: `router.<método>('<ruta>'` en cada módulo, con su prefijo. */
function rutasDelCodigo(): Set<string> {
  const rutas = new Set<string>();
  const normalizar = (ruta: string) => ruta.replace(/:([a-z_]+)/g, '{$1}');

  const modulos = path.join(raiz, 'src', 'modules');
  for (const modulo of readdirSync(modulos, { withFileTypes: true })) {
    if (!modulo.isDirectory()) continue;
    for (const archivo of readdirSync(path.join(modulos, modulo.name))) {
      if (!archivo.endsWith('.routes.ts')) continue;
      const codigo = readFileSync(path.join(modulos, modulo.name, archivo), 'utf8');
      // Cada módulo se monta en /<nombre-del-directorio> (ver app.ts)
      for (const [, metodo, ruta] of codigo.matchAll(
        /router\.(get|post|patch|delete)\(\s*'([^']*)'/g,
      )) {
        const completa = ruta === '/' ? `/${modulo.name}` : `/${modulo.name}${ruta}`;
        rutas.add(`${metodo!.toUpperCase()} ${normalizar(completa)}`);
      }
    }
  }
  const app = readFileSync(path.join(raiz, 'src', 'app.ts'), 'utf8');
  for (const [, metodo, ruta] of app.matchAll(/api\.(get|post|patch|delete)\(\s*'([^']*)'/g)) {
    rutas.add(`${metodo!.toUpperCase()} ${normalizar(ruta!)}`);
  }
  return rutas;
}

async function leerSpec() {
  return (await SwaggerParser.parse(rutaSpec)) as unknown as {
    paths: Record<string, ItemDeRuta>;
  };
}

function operacionesDeLaSpec(paths: Record<string, ItemDeRuta>) {
  const operaciones: { clave: string; ruta: string; metodo: string; operacion: Operacion }[] = [];
  for (const [ruta, item] of Object.entries(paths)) {
    for (const metodo of METODOS) {
      const operacion = item[metodo] as Operacion | undefined;
      if (operacion)
        operaciones.push({ clave: `${metodo.toUpperCase()} ${ruta}`, ruta, metodo, operacion });
    }
  }
  return operaciones;
}

describe('openapi.yaml', () => {
  it('es una especificación OpenAPI válida', async () => {
    await expect(SwaggerParser.validate(rutaSpec)).resolves.toBeDefined();
  });

  it('documenta exactamente las rutas que existen en el código (ni de más ni de menos)', async () => {
    const { paths } = await leerSpec();
    const enLaSpec = new Set(operacionesDeLaSpec(paths).map((o) => o.clave));
    const enElCodigo = rutasDelCodigo();

    expect(enElCodigo.size).toBeGreaterThan(40);
    expect(
      [...enElCodigo].filter((clave) => !enLaSpec.has(clave)).sort(),
      'rutas sin documentar',
    ).toEqual([]);
    expect(
      [...enLaSpec].filter((clave) => !enElCodigo.has(clave)).sort(),
      'rutas documentadas que no existen',
    ).toEqual([]);
  });

  it('cada operación tiene un operationId único', async () => {
    const { paths } = await leerSpec();
    const ids = operacionesDeLaSpec(paths).map((o) => o.operacion.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('las operaciones que modifican datos exigen el encabezado anti-CSRF', async () => {
    const { paths } = await leerSpec();
    for (const { clave, metodo, operacion } of operacionesDeLaSpec(paths)) {
      if (metodo === 'get') continue;
      const exige = operacion.parameters?.some(
        (p) => p.$ref === '#/components/parameters/CsrfHeader',
      );
      expect(exige, clave).toBe(true);
    }
  });

  it('todas las operaciones protegidas documentan el 401, y solo salud y login son públicas', async () => {
    const { paths } = await leerSpec();
    const publicas: string[] = [];
    for (const { clave, operacion } of operacionesDeLaSpec(paths)) {
      if (Array.isArray(operacion.security) && operacion.security.length === 0)
        publicas.push(clave);
      else expect(operacion.responses, clave).toHaveProperty('401');
    }
    expect(publicas.sort()).toEqual(['GET /salud', 'POST /auth/login']);
  });

  it('los parámetros de ruta declarados coinciden con los de la URL', async () => {
    const { paths } = await leerSpec();
    for (const [ruta, item] of Object.entries(paths)) {
      const enLaUrl = [...ruta.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
      if (enLaUrl.length === 0) continue;
      const declarados = (
        (item.parameters as { $ref?: string; name?: string; in?: string }[] | undefined) ?? []
      ).map((p) => (p.$ref === '#/components/parameters/IdRuta' ? 'id' : p.name));
      expect(declarados.sort(), ruta).toEqual([...enLaUrl].sort());
    }
  });
});
