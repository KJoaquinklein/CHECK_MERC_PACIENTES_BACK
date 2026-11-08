-- Up Migration
-- Permisos del rol de la aplicación (hc_app). Los roles se crean con `npm run crear-roles`.
-- Esta migración la ejecuta hc_migrator, dueño de las tablas. Repetir los GRANT/REVOKE
-- correspondientes cada vez que se agregue una tabla que no deba seguir la regla general.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hc_app') THEN
    RAISE EXCEPTION 'No existe el rol hc_app. Ejecutá primero: npm run crear-roles';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO hc_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO hc_app;
GRANT DELETE ON sesion TO hc_app;                      -- único DELETE permitido
REVOKE UPDATE ON consulta_contenido, auditoria FROM hc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hc_app;

-- La tabla de control de migraciones no es de la aplicación
REVOKE ALL ON pgmigrations FROM hc_app;

-- Las tablas y secuencias futuras creadas por el dueño del esquema quedan con el permiso
-- general (sin DELETE). Si una tabla nueva es de solo inserción, hay que revocar UPDATE.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO hc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hc_app;

-- Down Migration
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE ON TABLES FROM hc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM hc_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM hc_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM hc_app;
