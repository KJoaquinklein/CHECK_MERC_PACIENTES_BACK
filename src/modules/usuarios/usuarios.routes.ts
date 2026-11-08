import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { requerirRol } from '../../middleware/auth.js';
import { ipDe } from '../auditoria/auditoria.service.js';
import { esquemaParamsId } from '../comun/sql.js';
import {
  esquemaCrearUsuario,
  esquemaEditarUsuario,
  esquemaListarUsuarios,
  esquemaResetPassword,
} from './usuarios.schemas.js';
import * as servicio from './usuarios.service.js';

export function crearUsuariosRouter(deps: { pool: pg.Pool; autenticar: RequestHandler }): Router {
  const { pool } = deps;
  const router = Router();
  router.use(deps.autenticar, requerirRol('admin'));

  const actorDe = (req: Parameters<RequestHandler>[0]): servicio.Actor => ({
    id: req.usuario!.id,
    ip: ipDe(req),
  });

  router.post('/', async (req, res) => {
    const datos = esquemaCrearUsuario.parse(req.body);
    res.status(201).json(await servicio.crear(pool, actorDe(req), datos));
  });

  router.get('/', async (req, res) => {
    const filtros = esquemaListarUsuarios.parse(req.query);
    res.json(await servicio.listar(pool, filtros));
  });

  router.get('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.obtener(pool, id));
  });

  router.patch('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    const cambios = esquemaEditarUsuario.parse(req.body);
    res.json(await servicio.editar(pool, actorDe(req), id, cambios));
  });

  router.post('/:id/reset-password', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    const { password_temporal } = esquemaResetPassword.parse(req.body);
    res.json(await servicio.restablecerPassword(pool, actorDe(req), id, password_temporal));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.desactivar(pool, actorDe(req), id));
  });

  return router;
}
