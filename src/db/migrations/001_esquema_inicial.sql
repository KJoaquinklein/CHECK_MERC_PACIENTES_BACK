-- Up Migration
-- =====================================================================
-- Esquema PostgreSQL: sistema de gestión de historias clínicas
-- Requiere PostgreSQL 13+ (columnas generadas, gen_random_uuid)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- búsqueda parcial por nombre
CREATE EXTENSION IF NOT EXISTS unaccent;  -- ignorar tildes al buscar

-- unaccent() no es IMMUTABLE y no se puede usar en índices ni columnas
-- generadas; este wrapper resuelve eso.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

-- Configuración de búsqueda de texto completo: español + sin tildes
CREATE TEXT SEARCH CONFIGURATION es_unaccent (COPY = pg_catalog.spanish);
ALTER TEXT SEARCH CONFIGURATION es_unaccent
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, spanish_stem;

-- ---------------------------------------------------------------------
-- Usuarios del sistema
-- ---------------------------------------------------------------------
CREATE TABLE usuario (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre_usuario  text NOT NULL UNIQUE,
  password_hash   text NOT NULL,           -- argon2id o bcrypt, nunca texto plano
  nombre_completo text NOT NULL,
  rol             text NOT NULL DEFAULT 'profesional'
                  CHECK (rol IN ('admin', 'profesional')),
  activo          boolean NOT NULL DEFAULT true,
  debe_cambiar_password boolean NOT NULL DEFAULT false,
  intentos_fallidos     integer NOT NULL DEFAULT 0,
  bloqueado_hasta       timestamptz,
  ultimo_login          timestamptz,
  creado_en       timestamptz NOT NULL DEFAULT now()
);

-- Sesiones del lado del servidor (token opaco; se guarda solo su hash).
-- Permiten cerrar sesión y revocar el acceso al instante.
CREATE TABLE sesion (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_usuario  bigint NOT NULL REFERENCES usuario (id) ON DELETE CASCADE,
  token_hash  char(64) NOT NULL UNIQUE,    -- sha256 del token
  creado_en   timestamptz NOT NULL DEFAULT now(),
  ultimo_uso  timestamptz NOT NULL DEFAULT now(),
  expira_en   timestamptz NOT NULL,
  revocada    boolean NOT NULL DEFAULT false,
  ip          inet,
  user_agent  text
);
CREATE INDEX sesion_usuario_idx ON sesion (id_usuario);

-- ---------------------------------------------------------------------
-- Obras sociales / mutuales (catálogo)
-- ---------------------------------------------------------------------
CREATE TABLE obra_social (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre text NOT NULL,
  activa boolean NOT NULL DEFAULT true     -- baja lógica
);
CREATE UNIQUE INDEX obra_social_nombre_uk ON obra_social (lower(nombre));

-- ---------------------------------------------------------------------
-- Pacientes
-- ---------------------------------------------------------------------
CREATE TABLE paciente (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre_completo  text NOT NULL,
  dni              text,                    -- solo dígitos; NULL en pacientes migrados sin dato
  fecha_nacimiento date,
  telefono         text,
  email            text,
  domicilio        text,
  id_obra_social   bigint REFERENCES obra_social (id),
  nro_afiliado     text,
  observaciones    text,
  activo           boolean NOT NULL DEFAULT true,   -- baja lógica
  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz NOT NULL DEFAULT now(),
  origen_uuid      text UNIQUE,                     -- NBS_UUID de OpenKM (migración)

  -- Texto único de búsqueda: nombre, DNI, afiliado, teléfono y mail,
  -- en minúsculas y sin tildes.
  busqueda         text GENERATED ALWAYS AS (
    f_unaccent(lower(
      nombre_completo || ' ' || coalesce(dni, '') || ' ' ||
      coalesce(nro_afiliado, '') || ' ' || coalesce(telefono, '') || ' ' ||
      coalesce(email, '')
    ))
  ) STORED
);
CREATE UNIQUE INDEX paciente_dni_uk ON paciente (dni) WHERE dni IS NOT NULL;
CREATE INDEX paciente_busqueda_trgm ON paciente USING gin (busqueda gin_trgm_ops);
CREATE INDEX paciente_obra_social_idx ON paciente (id_obra_social);
CREATE INDEX paciente_creado_idx ON paciente (creado_en);

-- ---------------------------------------------------------------------
-- Consultas (cabecera): una fila por consulta, nunca se borra
-- ---------------------------------------------------------------------
CREATE TABLE consulta (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_paciente    bigint NOT NULL REFERENCES paciente (id),
  fecha_consulta timestamptz NOT NULL DEFAULT now(),  -- fecha clínica
  fecha_estimada boolean NOT NULL DEFAULT false,      -- true si se migró sin fecha real
  anulada        boolean NOT NULL DEFAULT false,      -- baja lógica
  creado_en      timestamptz NOT NULL DEFAULT now(),  -- cuándo se cargó
  id_usuario     bigint REFERENCES usuario (id),      -- NULL en migradas
  origen_uuid    text UNIQUE                          -- NNT_UUID de OpenKM
);
CREATE INDEX consulta_paciente_fecha_idx ON consulta (id_paciente, fecha_consulta DESC);
CREATE INDEX consulta_fecha_idx ON consulta (fecha_consulta);

-- ---------------------------------------------------------------------
-- Contenido de la consulta: solo inserción. version 0 = original,
-- 1, 2, 3... = ediciones. La vigente es la de mayor versión.
-- ---------------------------------------------------------------------
CREATE TABLE consulta_contenido (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_consulta    bigint NOT NULL REFERENCES consulta (id),
  version        integer NOT NULL CHECK (version >= 0),
  contenido      text NOT NULL,
  motivo_edicion text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  id_usuario     bigint REFERENCES usuario (id),
  busqueda       tsvector GENERATED ALWAYS AS (to_tsvector('es_unaccent', contenido)) STORED,
  UNIQUE (id_consulta, version)
);
CREATE INDEX consulta_contenido_busqueda_idx ON consulta_contenido USING gin (busqueda);

-- Garantiza la trazabilidad: no se puede modificar ni borrar un registro
-- de las tablas de solo inserción (consulta_contenido y auditoria).
CREATE OR REPLACE FUNCTION bloquear_modificacion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción (%)', TG_TABLE_NAME, TG_OP;
END;
$$;
CREATE TRIGGER trg_consulta_contenido_inmutable
  BEFORE UPDATE OR DELETE ON consulta_contenido
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();

-- Versión vigente de cada consulta
CREATE VIEW consulta_actual AS
SELECT DISTINCT ON (cc.id_consulta)
       c.id, c.id_paciente, c.fecha_consulta, c.fecha_estimada, c.anulada,
       cc.id AS id_contenido, cc.version, cc.contenido, cc.busqueda,
       cc.creado_en AS editado_en, cc.id_usuario AS editado_por,
       (cc.version > 0) AS fue_editada
FROM consulta c
JOIN consulta_contenido cc ON cc.id_consulta = c.id
ORDER BY cc.id_consulta, cc.version DESC;

-- ---------------------------------------------------------------------
-- Archivos de pacientes: fichas antiguas migradas (png/jpg) y estudios
-- nuevos (pdf/png/jpg). El binario vive en el almacenamiento (disco local
-- o bucket S3-compatible); acá solo van los datos. El binario es inmutable.
-- ---------------------------------------------------------------------
CREATE TABLE paciente_archivo (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_paciente     bigint NOT NULL REFERENCES paciente (id),
  id_consulta     bigint REFERENCES consulta (id),      -- opcional
  tipo            text NOT NULL DEFAULT 'estudio'
                  CHECK (tipo IN ('ficha_antigua', 'estudio')),
  descripcion     text,
  fecha_documento date,                                 -- fecha del estudio o de la ficha
  nombre_original text NOT NULL,
  mime_type       text NOT NULL
                  CHECK (mime_type IN ('image/png', 'image/jpeg', 'application/pdf')),
  tamano_bytes    bigint NOT NULL CHECK (tamano_bytes > 0),
  sha256          char(64) NOT NULL,
  storage_key     text NOT NULL UNIQUE,                 -- ej: estudios/123/<uuid>.pdf
  id_usuario      bigint REFERENCES usuario (id),       -- quién lo subió (NULL en migrados)
  eliminado       boolean NOT NULL DEFAULT false,       -- baja lógica
  eliminado_en    timestamptz,
  origen_uuid     text UNIQUE,                          -- NBS_UUID de OpenKM
  creado_en       timestamptz NOT NULL DEFAULT now(),   -- fecha original si se migró
  subido_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paciente_archivo_paciente_idx ON paciente_archivo (id_paciente, tipo);

-- ---------------------------------------------------------------------
-- Auditoría de accesos y cambios (datos de salud: conviene saber quién vio qué)
-- ---------------------------------------------------------------------
CREATE TABLE auditoria (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha      timestamptz NOT NULL DEFAULT now(),
  id_usuario bigint REFERENCES usuario (id),
  accion     text NOT NULL,       -- 'login', 'ver_paciente', 'editar_consulta', ...
  entidad    text,
  entidad_id bigint,
  ip         inet,
  detalle    jsonb                -- campos modificados / antes y después; nunca texto clínico
);
CREATE INDEX auditoria_fecha_idx ON auditoria (fecha);
CREATE INDEX auditoria_usuario_idx ON auditoria (id_usuario, fecha);
CREATE INDEX auditoria_entidad_idx ON auditoria (entidad, entidad_id);
CREATE TRIGGER trg_auditoria_inmutable
  BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();

-- ---------------------------------------------------------------------
-- Reportes (análisis de datos). Meses en hora de Córdoba.
-- ---------------------------------------------------------------------
CREATE VIEW reporte_consultas_por_mes AS
SELECT date_trunc('month', fecha_consulta AT TIME ZONE 'America/Argentina/Cordoba')::date AS mes,
       count(*) AS consultas
FROM consulta WHERE NOT anulada
GROUP BY 1 ORDER BY 1;

CREATE VIEW reporte_pacientes_nuevos_por_mes AS
SELECT date_trunc('month', creado_en AT TIME ZONE 'America/Argentina/Cordoba')::date AS mes,
       count(*) AS pacientes_nuevos
FROM paciente
GROUP BY 1 ORDER BY 1;

CREATE VIEW reporte_ediciones_por_mes AS
SELECT date_trunc('month', creado_en AT TIME ZONE 'America/Argentina/Cordoba')::date AS mes,
       count(*) AS ediciones,
       count(DISTINCT id_consulta) AS consultas_modificadas
FROM consulta_contenido WHERE version > 0
GROUP BY 1 ORDER BY 1;


-- Down Migration
-- Solo para desarrollo y tests: elimina todo el esquema.
DROP VIEW IF EXISTS reporte_ediciones_por_mes, reporte_pacientes_nuevos_por_mes,
  reporte_consultas_por_mes, consulta_actual;
DROP TABLE IF EXISTS auditoria, paciente_archivo, consulta_contenido, consulta, paciente,
  obra_social, sesion, usuario;
DROP FUNCTION IF EXISTS bloquear_modificacion();
DROP TEXT SEARCH CONFIGURATION IF EXISTS es_unaccent;
DROP FUNCTION IF EXISTS f_unaccent(text);
DROP EXTENSION IF EXISTS unaccent;
DROP EXTENSION IF EXISTS pg_trgm;
