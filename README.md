# Backend de historias clínicas

API para el sistema de gestión de historias clínicas de una profesional de la salud. Reemplaza a un
OpenKM viejo y registra **pacientes**, **consultas con historial de versiones**, **archivos**
(estudios nuevos y fichas antiguas escaneadas), **reportes** y **auditoría** de quién hizo qué.

Son **datos de salud** (datos sensibles): la seguridad, la integridad y la trazabilidad no son
opcionales. Nada se borra físicamente; toda edición de una consulta crea una versión nueva.

- Stack: Node.js 22 · TypeScript estricto · Express · PostgreSQL 16 (`pg`, SQL parametrizado a mano) ·
  `zod` · sesiones del lado del servidor · `argon2id` · `pino` · `vitest`.
- Documentación de la API: [`openapi.yaml`](openapi.yaml) (se valida y se compara contra las rutas
  del código en cada corrida de tests).
- Decisiones de diseño, ambigüedades resueltas y revisión de seguridad: [`DECISIONES.md`](DECISIONES.md).

## Requisitos

- Node.js 22 o superior y npm.
- Una base PostgreSQL 13 o superior (se desarrolla y prueba contra 16) con las extensiones
  `pg_trgm` y `unaccent` (son "de confianza": las crea `hc_migrator`).
- Para producción: un bucket S3-compatible **privado** (Backblaze B2 o Cloudflare R2).
- Para backups: `bash` y las herramientas cliente de PostgreSQL (`pg_dump`, `pg_restore`, `psql`) de
  una versión igual o mayor que la del servidor.

## Puesta en marcha para desarrollo

```bash
npm ci
cp .env.example .env     # completar las variables (ver más abajo)
```

La API usa **dos roles de base de datos** (defensa en profundidad): `hc_migrator` es dueño del
esquema y solo lo usan las migraciones; `hc_app` es el que usa la API y **no puede borrar filas ni
modificar** `consulta_contenido` y `auditoria`. Se crean una sola vez por base:

```bash
# 1. Crear los roles (con el usuario administrador que da el hosting)
#    Variables: ADMIN_DATABASE_URL, HC_MIGRATOR_PASSWORD, HC_APP_PASSWORD  (16+ caracteres, distintas)
npm run crear-roles

# 2. Crear las tablas y los permisos (usa MIGRATIONS_DATABASE_URL = hc_migrator)
npm run migrar

# 3. Crear el primer administrador (pide usuario, nombre y contraseña por consola; no hay
#    credenciales por defecto ni registro público)
npm run crear-admin

# 4. Levantar la API con recarga automática
npm run dev        # http://localhost:3000/salud
```

Con Docker (opcional) hay un `docker-compose.yml` con PostgreSQL 16 y MinIO. **No se pudo probar en
la máquina donde se desarrolló** (sin Docker); si algo falla, corregirlo y avisar.

### Variables de entorno

Todas están documentadas en [`.env.example`](.env.example) y se **validan al arrancar**: si falta
alguna o es inválida el servidor no inicia y lo dice con un mensaje claro (sin mostrar valores). Las
principales:

| Variable                         | Para qué sirve                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`, `DATABASE_SSL`   | Conexión de la API (rol `hc_app`). `DATABASE_SSL=true` en hostings administrados. |
| `MIGRATIONS_DATABASE_URL`        | Conexión de `hc_migrator`, solo para `npm run migrar`.                            |
| `CORS_ORIGINS`                   | Origen(es) exacto(s) del frontend.                                                |
| `TRUST_PROXY`                    | Cantidad de proxies delante de la API (1 en un hosting).                          |
| `STORAGE_DRIVER`                 | `local` (solo desarrollo y tests) o `s3` (producción) + variables `S3_*`.         |
| `MAX_UPLOAD_MB`, `DOWNLOAD_MODE` | Tamaño máximo de subida; descarga transmitida o por URL firmada.                  |
| `CSV_SEPARADOR`                  | `;` (por defecto, Excel en español) o `,`.                                        |

### Comandos

| Comando                                | Qué hace                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `npm run dev`                          | API con recarga automática (carga `.env`).                                  |
| `npm run build` / `npm start`          | Compila a `dist/` (incluye las migraciones) / ejecuta lo compilado.         |
| `npm run migrar` / `migrar:prod`       | Aplica las migraciones pendientes (`-- down 1` revierte; no en producción). |
| `npm run crear-roles` / `crear-admin`  | Ver arriba. Con `:prod` ejecutan lo compilado.                              |
| `npm run backup` / `npm run restaurar` | Copia de seguridad y restauración (ver más abajo).                          |
| `npm test`                             | Todos los tests (ver más abajo).                                            |
| `npm run typecheck`, `lint`, `format`  | Tipos, ESLint y Prettier.                                                   |

## Tests

Los tests de integración usan un **PostgreSQL real** (los triggers y permisos hay que probarlos de
verdad) y **vacían y recrean el esquema en cada corrida**. Por eso:

- Necesitan una base **separada** de la real; su nombre debe contener `test`, `prueba`, `dev` o
  `desarrollo` (si no, se niegan a correr). Variables: `TEST_DATABASE_URL` (`hc_app`),
  `TEST_MIGRATIONS_DATABASE_URL` (`hc_migrator`) y `TEST_DATABASE_SSL`.
- **No ejecutar dos corridas de `vitest` a la vez contra la misma base**: la segunda reinicia el
  esquema y rompe a la primera. Esto vale incluso para archivos de tests que no usan la base.
- La suite completa tarda entre 15 y 25 minutos contra una base remota (depende de la latencia; el tiempo máximo por test es de 60 segundos). Para iterar, correr un archivo:
  `npx vitest run tests/consultas.test.ts`.
- Sin las variables `TEST_*`, los tests de integración se omiten y corren los demás.
- Las pruebas de almacenamiento usan el SDK real de AWS contra un servidor S3 simulado. Antes de
  salir a producción conviene correrlas una vez contra un bucket **de pruebas** del proveedor
  elegido (variables `TEST_S3_*`).
- Los tests de los scripts de backup usan herramientas de PostgreSQL simuladas (necesitan `bash`).

## API

Ver [`openapi.yaml`](openapi.yaml) (se puede abrir en Swagger Editor o importar en Postman/Insomnia).
Lo que el frontend debe saber:

- **Sesión por cookie** `sid` (`HttpOnly`, `Secure`, `SameSite=Strict`): usar `credentials: 'include'`.
  El frontend y la API deben estar bajo el **mismo dominio registrable** (por ejemplo
  `app.midominio.com` y `api.midominio.com`); con dominios distintos la cookie no viaja y el login
  no funciona.
- **Encabezado `X-Requested-With`** (cualquier valor) en todo POST, PATCH y DELETE (protección CSRF).
- Listados paginados `{ data, meta }`; errores `{ error: { code, message, details?, request_id? } }`.
- Si el usuario tiene `debe_cambiar_password`, solo puede cambiarla (o cerrar sesión).
- Edición de consultas: enviar `version_base`; un `409 CONFLICTO_VERSION` indica que otra persona
  editó antes y hay que recargar.

## Despliegue en producción (Plan 3: todo en la nube)

1. **Dominio y HTTPS.** Frontend y API bajo el mismo dominio registrable, ambos con HTTPS. La API
   corre detrás de un proxy del proveedor: definir `TRUST_PROXY=1` para que la IP real quede en la
   auditoría y los límites de intentos funcionen. `CORS_ORIGINS` = el origen exacto del frontend.
2. **Base de datos administrada** con backups automáticos y retención suficiente. Crear los roles
   (`npm run crear-roles:prod`) y migrar (`npm run migrar:prod`). **Probar una restauración antes de
   la puesta en marcha** (ver "Copias de seguridad").
3. **Almacenamiento.** `STORAGE_DRIVER=s3` con un bucket privado (nunca público) en una cuenta a
   nombre del cliente; habilitar el versionado del bucket. Con `NODE_ENV=production` el driver
   `local` se rechaza.
4. **Migraciones como paso aparte del despliegue**, con `hc_migrator`; la API corre solo con
   `hc_app`. Preferir ejecutarlas desde un job o comando puntual con sus propias variables en vez de
   dejar `MIGRATIONS_DATABASE_URL` entre las del servicio web.
5. **Servicio siempre activo.** Evitar planes de hosting que apagan la aplicación por inactividad
   (la primera petición tarda mucho y las sesiones largas se cortan).
6. **Límites de subida.** El tamaño máximo de petición del proveedor y del proxy debe ser mayor o
   igual a `MAX_UPLOAD_MB` (25 MB por defecto) más el formulario.
7. **Primer administrador:** `npm run crear-admin:prod` desde una consola interactiva del servicio.

La imagen se construye con el [`Dockerfile`](Dockerfile) (multi-etapa, usuario no root, `GET /salud`
como healthcheck, arranque con `node dist/server.js`). Tampoco se pudo construir en la máquina de
desarrollo: la primera construcción en el proveedor (o con Docker) confirma que funciona. Sin Docker
se puede desplegar como servicio Node: _build_ `npm ci && npm run build`, _start_ `npm start`.

Variables mínimas de producción: `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_SSL`,
`CORS_ORIGINS`, `TRUST_PROXY`, `STORAGE_DRIVER=s3` y las cinco `S3_*`. El resto tiene valores por
defecto razonables (ver `.env.example`).

## Copias de seguridad y restauración

`npm run backup [directorio]` genera una copia comprimida (`pg_dump` formato custom) con su SHA-256,
la verifica y borra las anteriores a `BACKUP_RETENCION_DIAS`. Es un respaldo **adicional** a los
backups automáticos de la base administrada. Lo que hay que saber:

- La copia contiene datos clínicos y hashes de contraseñas: guardarla **cifrada y privada**.
- **No incluye los archivos del bucket**; esos se respaldan con el versionado o la replicación del
  proveedor del bucket.
- Usa `BACKUP_DATABASE_URL` (o `MIGRATIONS_DATABASE_URL`); `hc_app` no sirve porque no lee la tabla de
  migraciones. La contraseña viaja por variables de entorno de PostgreSQL, nunca como argumento.

Restaurar en una base **nueva y vacía** (nunca se restaura sobre una que ya tiene tablas):

```bash
# 1. Crear la base vacía en el proveedor
# 2. Crear los roles en esa base (ADMIN_DATABASE_URL apuntando a la base nueva)
npm run crear-roles
# 3. Restaurar (RESTORE_DATABASE_URL = hc_migrator sobre la base nueva)
npm run restaurar -- ./backups/historias-clinicas-20261105T120000Z.dump
# 4. Apuntar DATABASE_URL (hc_app) a la base nueva y comprobar GET /salud
```

`restaurar` verifica el SHA-256, comprueba que la base destino esté vacía y que exista `hc_app`,
restaura todo o nada (`--single-transaction`) y muestra la cantidad de filas por tabla. Los permisos
de `hc_app` se restauran junto con el resto.

## Seguridad

La revisión punto por punto de la lista de seguridad del plan, con la evidencia de cada ítem, está
en [`DECISIONES.md`](DECISIONES.md) (Fase 7). En resumen: SQL siempre parametrizado, toda entrada
validada con `zod` (campos desconocidos rechazados), rol de base sin permiso de borrar, cookie
`HttpOnly`/`Secure`/`SameSite=Strict` más encabezado anti-CSRF, `helmet`, CORS con lista explícita,
límites de tamaño y de intentos, logs sin datos personales y errores internos genéricos con
`request_id`.

## Estructura

```
src/
  config/        env.ts (variables validadas), logger.ts, seguridad.ts
  db/            pool.ts, tx.ts, migrar.ts, migrations/ (001 esquema, 002 permisos)
  middleware/    auth (sesión, roles, CSRF), errores
  storage/       driver.ts, local.driver.ts, s3.driver.ts
  modules/       auth · usuarios · obras-sociales · pacientes · consultas · archivos ·
                 reportes · auditoria      (cada uno: routes / service / repo / schemas)
  scripts/       crear-roles.ts, crear-admin.ts, migrar.ts
  app.ts  server.ts
scripts/         backup.sh, restaurar.sh, lib-postgres.sh, utilidades de build
tests/           integración contra PostgreSQL real + unitarios
openapi.yaml  DECISIONES.md  Dockerfile  docker-compose.yml  .env.example
```

## Pendiente de definir con el desarrollador

Tomados del plan (sección 13); no bloquean el código, que es configurable:

1. **Proveedor de almacenamiento** (Backblaze B2 o Cloudflare R2), con la cuenta a nombre del cliente.
2. **Rol de la doctora:** `admin` (ve la auditoría y crea usuarios) o `profesional`.
3. **Tamaño máximo de archivo** (25 MB por defecto) y **plazo de conservación** de la historia clínica.
4. **Hosting y PostgreSQL administrado** (backups automáticos con retención suficiente, sin apagado
   por inactividad).
5. **Alcance y precio** de la subida de estudios nuevos, que no estaba en el presupuesto original.

Cumplimiento (fuera del alcance del código; consultar a un asesor legal): Ley 26.529 (derechos del
paciente e historia clínica) y Ley 25.326 (protección de datos personales; reglas para transferirlos
al exterior si el proveedor de nube está fuera del país).
