#!/usr/bin/env bash
# Copia de seguridad lógica de la base de datos (pg_dump en formato custom, comprimido).
#
# Uso:    scripts/backup.sh [directorio]        (por defecto ./backups)
# Entorno:
#   BACKUP_DATABASE_URL      conexión con permiso de lectura sobre TODAS las tablas. Por defecto
#                            usa MIGRATIONS_DATABASE_URL (hc_migrator, el dueño del esquema);
#                            hc_app NO sirve porque no puede leer la tabla de migraciones.
#   BACKUP_RETENCION_DIAS    días que se conservan las copias en el directorio (30 por defecto)
#
# Importante:
#  * La copia incluye datos clínicos y hashes de contraseñas: guardala en un lugar cifrado y
#    privado, nunca en el repositorio ni en un bucket público.
#  * NO incluye los archivos (PDF e imágenes) que viven en el bucket: eso se respalda con el
#    versionado/replicación del proveedor del bucket.
#  * Es un respaldo ADICIONAL a los backups automáticos de la base administrada.
set -euo pipefail
umask 077

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-postgres.sh
source "$AQUI/lib-postgres.sh"

DIRECTORIO="${1:-${BACKUP_DIR:-./backups}}"
URL="${BACKUP_DATABASE_URL:-${MIGRATIONS_DATABASE_URL:-}}"
RETENCION="${BACKUP_RETENCION_DIAS:-30}"

if [[ -z "$URL" ]]; then
  echo "Falta BACKUP_DATABASE_URL (o MIGRATIONS_DATABASE_URL)." >&2
  exit 1
fi
if ! [[ "$RETENCION" =~ ^[1-9][0-9]*$ ]]; then
  echo "BACKUP_RETENCION_DIAS debe ser un entero positivo." >&2
  exit 1
fi

exigir_comando pg_dump
exigir_comando pg_restore
exportar_conexion "$URL"

mkdir -p "$DIRECTORIO"
chmod 700 "$DIRECTORIO"
ARCHIVO="$DIRECTORIO/historias-clinicas-$(date -u +%Y%m%dT%H%M%SZ).dump"

echo "Generando copia de la base \"$PGDATABASE\" en $PGHOST..."
# --no-owner: los objetos quedan a nombre de quien restaure (hc_migrator) en la base nueva.
# Los permisos (GRANT) sí se conservan: la base destino necesita el rol hc_app (npm run crear-roles).
if ! pg_dump --format=custom --compress=9 --no-owner --file "$ARCHIVO.parcial"; then
  rm -f "$ARCHIVO.parcial"
  echo "Falló pg_dump: no se generó la copia." >&2
  exit 1
fi
mv "$ARCHIVO.parcial" "$ARCHIVO"

# Una copia que no se puede leer no sirve: se comprueba antes de darla por buena
if ! pg_restore --list "$ARCHIVO" > /dev/null; then
  rm -f "$ARCHIVO"
  echo "La copia generada está dañada y se descartó." >&2
  exit 1
fi

HUELLA="$(calcular_sha256 "$ARCHIVO")"
echo "$HUELLA  $(basename "$ARCHIVO")" > "$ARCHIVO.sha256"

# Retención: se borran las copias más viejas que BACKUP_RETENCION_DIAS
find "$DIRECTORIO" -maxdepth 1 -type f \
  \( -name 'historias-clinicas-*.dump' -o -name 'historias-clinicas-*.dump.sha256' \) \
  -mtime +"$RETENCION" -delete

echo "Copia lista: $ARCHIVO"
echo "SHA-256:     $HUELLA"
echo "Recordá que los archivos del bucket no están incluidos en esta copia."
