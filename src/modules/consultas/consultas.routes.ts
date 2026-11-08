import express, { Router, type Request, type RequestHandler } from 'express';
import type pg from 'pg';
import { ipDe } from '../auditoria/auditoria.service.js';
import { esquemaParamsId } from '../comun/sql.js';
import {
  esquemaCambiarFecha,
  esquemaCrearConsulta,
  esquemaListarConsultas,
  esquemaNuevaEdicion,
  esquemaParamsVersion,
} from './consultas.schemas.js';
import * as servicio from './consultas.service.js';

/**
 * Un contenido de 100.000 caracteres puede pesar hasta ~400 KB en JSON (4 bytes por carácter en
 * el peor caso), más que el límite general de 100 KB. Solo estas rutas admiten un cuerpo mayor.
 */
export const LIMITE_JSON_CONSULTAS = '450kb';

export function crearConsultasRouter(deps: { pool: pg.Pool; autenticar: RequestHandler }): Router {
  const { pool } = deps;
  const router = Router();
  router.use(express.json({ limit: LIMITE_JSON_CONSULTAS }));
  router.use(deps.autenticar);

  const actorDe = (req: Request): servicio.Actor => ({ id: req.usuario!.id, ip: ipDe(req) });

  router.get('/', async (req, res) => {
    res.json(await servicio.listar(pool, esquemaListarConsultas.parse(req.query)));
  });

  router.post('/', async (req, res) => {
    const datos = esquemaCrearConsulta.parse(req.body);
    res.status(201).json(await servicio.crear(pool, actorDe(req), datos));
  });

  router.get('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.ver(pool, actorDe(req), id));
  });

  router.get('/:id/versiones', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.verVersiones(pool, actorDe(req), id));
  });

  router.get('/:id/versiones/:version', async (req, res) => {
    const { id, version } = esquemaParamsVersion.parse(req.params);
    res.json(await servicio.verVersiones(pool, actorDe(req), id, version));
  });

  router.post('/:id/ediciones', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    const datos = esquemaNuevaEdicion.parse(req.body);
    res.status(201).json(await servicio.editar(pool, actorDe(req), id, datos));
  });

  router.patch('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    const { fecha_consulta } = esquemaCambiarFecha.parse(req.body);
    res.json(await servicio.cambiarFecha(pool, actorDe(req), id, fecha_consulta));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.anular(pool, actorDe(req), id));
  });

  router.post('/:id/restaurar', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.restaurar(pool, actorDe(req), id));
  });

  return router;
}
