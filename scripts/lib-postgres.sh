#!/usr/bin/env bash
# Funciones compartidas por backup.sh y restaurar.sh. Se usa con `source`, no se ejecuta solo.

# Decodifica un texto con %XX (como viene en una URL de conexión).
decodificar_url() {
  printf '%b' "${1//%/\\x}"
}

# Descompone una URL postgres://usuario:clave@host:puerto/base?sslmode=... en las variables de
# entorno estándar de PostgreSQL (PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE, PGSSLMODE).
# Así la contraseña NO viaja como argumento de pg_dump/psql, donde cualquier usuario del equipo
# la vería en la lista de procesos.
exportar_conexion() {
  local url="$1"
  case "$url" in
    postgres://* | postgresql://*) ;;
    *)
      echo "La URL de conexión debe empezar con postgres:// o postgresql://" >&2
      return 1
      ;;
  esac

  local resto="${url#*://}"
  if [[ "$resto" != *@* ]]; then
    echo "La URL de conexión debe incluir usuario y contraseña (usuario:clave@host/base)" >&2
    return 1
  fi
  local credenciales="${resto%%@*}"
  local destino="${resto#*@}"
  local usuario="${credenciales%%:*}"
  local clave=""
  if [[ "$credenciales" == *:* ]]; then clave="${credenciales#*:}"; fi

  if [[ "$destino" != */* ]]; then
    echo "La URL de conexión debe incluir el nombre de la base (host/base)" >&2
    return 1
  fi
  local host_puerto="${destino%%/*}"
  local ruta="${destino#*/}"
  local base="${ruta%%\?*}"
  local consulta=""
  if [[ "$ruta" == *\?* ]]; then consulta="${ruta#*\?}"; fi
  local host="${host_puerto%%:*}"
  local puerto="5432"
  if [[ "$host_puerto" == *:* ]]; then puerto="${host_puerto##*:}"; fi

  if [[ -z "$usuario" || -z "$host" || -z "$base" ]]; then
    echo "La URL de conexión está incompleta (faltan usuario, host o base)" >&2
    return 1
  fi

  export PGUSER="$(decodificar_url "$usuario")"
  export PGPASSWORD="$(decodificar_url "$clave")"
  export PGHOST="$host"
  export PGPORT="$puerto"
  export PGDATABASE="$(decodificar_url "$base")"

  # SSL: lo que diga la URL; si no dice nada, obligatorio salvo en la propia máquina
  local sslmode=""
  if [[ "$consulta" =~ (^|&)sslmode=([^&]+) ]]; then sslmode="${BASH_REMATCH[2]}"; fi
  if [[ -n "$sslmode" ]]; then
    export PGSSLMODE="$sslmode"
  elif [[ "$host" != "localhost" && "$host" != "127.0.0.1" && "$host" != "::1" ]]; then
    export PGSSLMODE="require"
  fi
}

# SHA-256 de un archivo (sha256sum en Linux, shasum en macOS).
calcular_sha256() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

exigir_comando() {
  if ! command -v "$1" > /dev/null 2>&1; then
    echo "Falta el comando '$1'. Instalá las herramientas cliente de PostgreSQL (versión igual o mayor que la del servidor)." >&2
    exit 1
  fi
}
