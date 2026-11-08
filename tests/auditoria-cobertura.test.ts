import { rmSync } from 'node:fs';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCIONES_AUDITORIA } from '../src/modules/auditoria/auditoria.service.js';
import {
  CLAVE_VALIDA,
  crearAppDePrueba,
  crearLlamador,
  ENCABEZADO_AJAX,
  insertarUsuario,
  iniciarSesionComo,
} from './utilidades/app.js';
import { PDF, subirArchivo } from './utilidades/archivos.js';
import {
  configBasePruebas,
  limpiarDatos,
  poolMigrador,
  type ConfigBasePruebas,
} from './utilidades/db.js';

const config: ConfigBasePruebas | null = configBasePruebas();

/** Todo lo "sensible" que se manda en este recorrido lleva esta marca para poder rastrearla. */
const MARCA = 'Q7X';

describe.skipIf(!config)('auditoría: cobertura de acciones y ausencia de datos sensibles', () => {
  let creada: ReturnType<typeof crearAppDePrueba>;
  let migrador: pg.Pool;

  beforeAll(async () => {
    creada = crearAppDePrueba(config!);
    migrador = poolMigrador(config!);
    await limpiarDatos(migrador);
  });
  afterAll(async () => {
    await creada.pool.end();
    await migrador.end();
    rmSync(creada.directorioStorage, { recursive: true, force: true });
  });

  it(
    'un recorrido por toda la API genera cada acción de la lista y no guarda texto clínico ni contraseñas',
    { timeout: 240_000 },
    async () => {
      const llamar = crearLlamador(creada.app);
      await insertarUsuario(migrador, { nombre_usuario: 'jefa', rol: 'admin' });

      // login_fallido (contraseña equivocada que contiene la marca) y login_ok
      await request(creada.app)
        .post('/auth/login')
        .set(ENCABEZADO_AJAX)
        .send({ nombre_usuario: 'jefa', password: `Equivocada-${MARCA}-123` })
        .expect(401);
      const cookie = await iniciarSesionComo(creada.app, 'jefa');
      const api = (metodo: 'get' | 'post' | 'patch' | 'delete', ruta: string, cuerpo?: object) =>
        llamar(metodo, ruta, cookie, cuerpo);

      // usuarios
      const usuario = await api('post', '/usuarios', {
        nombre_usuario: 'secretaria',
        nombre_completo: 'Ana Secretaria',
        rol: 'profesional',
        password_temporal: `Temporal-${MARCA}-0001`,
      });
      expect(usuario.status).toBe(201);
      await api('patch', `/usuarios/${usuario.body.id}`, { nombre_completo: 'Ana S.' }).expect(200);
      await api('post', `/usuarios/${usuario.body.id}/reset-password`, {
        password_temporal: `Temporal-${MARCA}-0002`,
      }).expect(200);
      await api('delete', `/usuarios/${usuario.body.id}`).expect(200);

      // pacientes
      const paciente = await api('post', '/pacientes/paciente', {
        nombre_completo: 'Paciente de Prueba',
        telefono: '3515550001',
        observaciones: `Alergia a la penicilina ${MARCA}`,
      });
      expect(paciente.status).toBe(201);
      const idPaciente = paciente.body.id as number;
      await api('get', `/pacientes/paciente/${idPaciente}`).expect(200);
      await api('patch', `/pacientes/paciente/${idPaciente}`, {
        telefono: '3515550002',
        observaciones: `Diabetes ${MARCA}`,
      }).expect(200);
      await api('delete', `/pacientes/paciente/${idPaciente}`).expect(200);
      await api('post', `/pacientes/paciente/${idPaciente}/reactivar`).expect(200);

      // consultas
      const consulta = await api('post', '/consultas', {
        id_paciente: idPaciente,
        contenido: `Cefalea intensa ${MARCA}`,
      });
      expect(consulta.status).toBe(201);
      const idConsulta = consulta.body.id as number;
      await api('get', `/consultas/${idConsulta}`).expect(200);
      await api('post', `/consultas/${idConsulta}/ediciones`, {
        contenido: `Cefalea intensa con náuseas ${MARCA}`,
        version_base: 0,
        motivo_edicion: `Faltaba un síntoma ${MARCA}`,
      }).expect(201);
      await api('patch', `/consultas/${idConsulta}`, {
        fecha_consulta: '2024-05-09T12:00:00-03:00',
      }).expect(200);
      await api('delete', `/consultas/${idConsulta}`).expect(200);
      await api('post', `/consultas/${idConsulta}/restaurar`).expect(200);

      // archivos
      const archivo = await subirArchivo(
        creada.app,
        cookie,
        { id_paciente: idPaciente, descripcion: `Resonancia de ${MARCA}` },
        { contenido: PDF, nombre: `Resonancia ${MARCA}.pdf`, mime: 'application/pdf' },
      );
      expect(archivo.status).toBe(201);
      const idArchivo = archivo.body.id as number;
      await request(creada.app)
        .get(`/archivos/${idArchivo}/contenido`)
        .set('Cookie', cookie)
        .expect(200);
      await api('patch', `/archivos/${idArchivo}`, {
        descripcion: `Otra descripción ${MARCA}`,
        fecha_documento: '2024-05-01',
      }).expect(200);
      await api('delete', `/archivos/${idArchivo}`).expect(200);
      await api('post', `/archivos/${idArchivo}/restaurar`).expect(200);

      // contraseña propia, lectura de la auditoría y cierre de sesión
      await api('post', '/auth/cambiar-password', {
        actual: CLAVE_VALIDA,
        nueva: `Nueva-${MARCA}-9999`,
      }).expect(200);
      const listado = await api('get', '/auditoria?page_size=1');
      expect(listado.status).toBe(200);
      await api('get', `/auditoria/${listado.body.data[0].id}`).expect(200);
      await api('post', '/auth/logout').expect(204);

      // --- verificación sobre todo lo que quedó registrado ---
      const { rows } = await migrador.query(
        'SELECT id_usuario, accion, entidad, entidad_id, ip, detalle FROM auditoria ORDER BY id',
      );
      const registradas = new Set(rows.map((fila) => fila.accion as string));
      const faltantes = ACCIONES_AUDITORIA.filter((accion) => !registradas.has(accion));
      expect(faltantes, `acciones sin registro: ${faltantes.join(', ')}`).toEqual([]);
      // No se registra nada fuera de la lista oficial
      const desconocidas = [...registradas].filter(
        (accion) => !(ACCIONES_AUDITORIA as readonly string[]).includes(accion),
      );
      expect(desconocidas).toEqual([]);

      // Ningún registro contiene texto clínico, nombres de archivo ni contraseñas
      const todo = JSON.stringify(rows);
      expect(todo).not.toContain(MARCA);
      expect(todo.toLowerCase()).not.toMatch(/penicilina|diabetes|cefalea|resonancia|náuseas/);

      // Los cambios y lecturas puntuales identifican al usuario y la entidad
      const conEntidad = rows.filter((fila) =>
        ['ver_paciente', 'consulta_editar', 'ver_archivo', 'archivo_baja'].includes(fila.accion),
      );
      expect(conEntidad.length).toBe(4);
      for (const fila of conEntidad) {
        expect(fila.id_usuario).not.toBeNull();
        expect(fila.entidad).not.toBeNull();
        expect(fila.entidad_id).not.toBeNull();
      }
    },
  );
});
