import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { esquemaParamsId } from '../comun/sql.js';
import {
  esquemaCrearObraSocial,
  esquemaEditarObraSocial,
  esquemaListarObrasSociales,
} from './obras-sociales.schemas.js';
import * as servicio from './obras-sociales.service.js';

/** Catálogo compartido: cualquier usuario autenticado puede leerlo y mantenerlo. */
export function crearObrasSocialesRouter(deps: {
  pool: pg.Pool;
  autenticar: RequestHandler;
}): Router {
  const { pool } = deps;
  const router = Router();
  router.use(deps.autenticar);

  router.get('/', async (req, res) => {
    res.json(await servicio.listar(pool, esquemaListarObrasSociales.parse(req.query)));
  });

  router.post('/', async (req, res) => {
    const { nombre } = esquemaCrearObraSocial.parse(req.body);
    res.status(201).json(await servicio.crear(pool, nombre));
  });

  router.patch('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.editar(pool, id, esquemaEditarObraSocial.parse(req.body)));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.desactivar(pool, id));
  });

  return router;
}
