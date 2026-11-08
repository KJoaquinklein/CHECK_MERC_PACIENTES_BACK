#!/usr/bin/env bash
# Restaura una copia hecha con backup.sh en una base de datos NUEVA y VACÍA.
#
# Uso:    scripts/restaurar.sh archivo.dump
# Entorno:
#   RESTORE_DATABASE_URL   conexión de hc_migrator a la base destino (vacía)
#
# Pasos previos (una sola vez por base destino):
#   1. Crear la base vacía en el proveedor.
#   2. ADMIN_DATABASE_URL=<admin de la base nueva> HC_MIGRATOR_PASSWORD=... HC_APP_PASSWORD=... \
#        npm run crear-roles
#   3. Ejecutar este script. Las tablas quedan a nombre de hc_migrator y los permisos de hc_app
#      se restauran con el resto.
# Nunca se restaura sobre una base que ya tiene tablas: para volver atrás se crea otra base.
set -euo pipefail
umask 077

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-postgres.sh
source "$AQUI/lib-postgres.sh"

ARCHIVO="${1:-}"
URL="${RESTORE_DATABASE_URL:-}"

if [[ -z "$ARCHIVO" ]]; then
  echo "Uso: scripts/restaurar.sh archivo.dump" >&2
  exit 1
fi
if [[ ! -f "$ARCHIVO" ]]; then
  echo "No existe el archivo $ARCHIVO" >&2
  exit 1
fi
if [[ -z "$URL" ]]; then
  echo "Falta RESTORE_DATABASE_URL (conexión de hc_migrator a la base destino)." >&2
  exit 1
fi

exigir_comando pg_restore
exigir_comando psql

# 1. Integridad del archivo
if [[ -f "$ARCHIVO.sha256" ]]; then
  ESPERADA="$(cut -d' ' -f1 "$ARCHIVO.sha256")"
  ACTUAL="$(calcular_sha256 "$ARCHIVO")"
  if [[ "$ESPERADA" != "$ACTUAL" ]]; then
    echo "El SHA-256 del archivo no coincide con el registrado: la copia está alterada o dañada." >&2
    exit 1
  fi
  echo "Integridad verificada (SHA-256)."
else
  echo "Aviso: no hay archivo .sha256 junto a la copia; no se puede verificar su integridad." >&2
fi
pg_restore --list "$ARCHIVO" > /dev/null

# 2. La base destino debe existir, estar vacía y tener los roles de la aplicación
exportar_conexion "$URL"
consultar() { psql --no-psqlrc --tuples-only --no-align --quiet --command "$1"; }

TABLAS="$(consultar "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [[ "$TABLAS" != "0" ]]; then
  echo "La base \"$PGDATABASE\" ya tiene $TABLAS tabla(s). Restaurá en una base nueva y vacía." >&2
  exit 1
fi
ROL_APP="$(consultar "SELECT count(*) FROM pg_roles WHERE rolname = 'hc_app'")"
if [[ "$ROL_APP" != "1" ]]; then
  echo "Falta el rol hc_app en el servidor. Ejecutá antes: npm run crear-roles" >&2
  exit 1
fi

# 3. Restauración, todo o nada
echo "Restaurando en la base \"$PGDATABASE\" de $PGHOST..."
pg_restore --no-owner --exit-on-error --single-transaction --dbname "$PGDATABASE" "$ARCHIVO"

# 4. Verificación: cantidad de filas de las tablas principales
echo "Restauración terminada. Filas por tabla:"
for tabla in usuario obra_social paciente consulta consulta_contenido paciente_archivo auditoria; do
  printf '  %-20s %s\n' "$tabla" "$(consultar "SELECT count(*) FROM $tabla")"
done
echo "Siguiente paso: apuntar DATABASE_URL de la API (rol hc_app) a esta base y comprobar GET /salud."
