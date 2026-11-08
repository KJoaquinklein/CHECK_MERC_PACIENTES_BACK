import { Router, type Request, type RequestHandler } from 'express';
import type pg from 'pg';
import { requerirRol } from '../../middleware/auth.js';
import { errores } from '../../errors.js';
import { esquemaParamsId, respuestaPaginada } from '../comun/sql.js';
import { esquemaListarAuditoria } from './auditoria.schemas.js';
import * as repo from './auditoria.repo.js';
import { ipDe, registrarAuditoria } from './auditoria.service.js';

/** Consulta de la auditoría: solo administradores. */
export function crearAuditoriaRouter(deps: { pool: pg.Pool; autenticar: RequestHandler }): Router {
  const { pool } = deps;
  const router = Router();
  router.use(deps.autenticar, requerirRol('admin'));

  /** Todos los registros, paginados, del más reciente al más antiguo. */
  router.get('/', async (req, res) => {
    const filtros = esquemaListarAuditoria.parse(req.query);
    const { filas, total } = await repo.listarAuditoria(pool, filtros);
    res.json(respuestaPaginada(filas, filtros.page, filtros.page_size, total));
  });

  // Va antes que '/:id' para que "acciones" no se interprete como un id
  router.get('/acciones', async (_req, res) => {
    res.json({ data: await repo.accionesExistentes(pool) });
  });

  /** Un registro. Abrirlo queda registrado (`auditoria_ver`); el listado, como todos, no. */
  router.get('/:id', async (req: Request, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    const registro = await repo.obtenerRegistro(pool, id);
    if (!registro) throw errores.noEncontrado('El registro de auditoría no existe');
    await registrarAuditoria(pool, {
      idUsuario: req.usuario!.id,
      accion: 'auditoria_ver',
      entidad: 'auditoria',
      entidadId: id,
      ip: ipDe(req),
    });
    res.json(registro);
  });

  return router;
}
