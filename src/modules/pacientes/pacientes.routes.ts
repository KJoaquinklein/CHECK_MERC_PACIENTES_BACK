import { Router, type Request, type RequestHandler } from 'express';
import type pg from 'pg';
import { ipDe } from '../auditoria/auditoria.service.js';
import { esquemaParamsId } from '../comun/sql.js';
import {
  esquemaConteoPacientes,
  esquemaCrearPaciente,
  esquemaEditarPaciente,
  esquemaListarPacientes,
} from './pacientes.schemas.js';
import * as servicio from './pacientes.service.js';

export function crearPacientesRouter(deps: { pool: pg.Pool; autenticar: RequestHandler }): Router {
  const { pool } = deps;
  const router = Router();
  router.use(deps.autenticar);

  const actorDe = (req: Request): servicio.Actor => ({ id: req.usuario!.id, ip: ipDe(req) });

  // Las rutas fijas van antes que las que llevan :id
  router.get('/', async (req, res) => {
    res.json(await servicio.listar(pool, esquemaListarPacientes.parse(req.query)));
  });

  router.get('/conteo', async (req, res) => {
    res.json(await servicio.contar(pool, esquemaConteoPacientes.parse(req.query)));
  });

  router.get('/resumen', async (_req, res) => {
    res.json(await servicio.resumen(pool));
  });

  router.post('/paciente', async (req, res) => {
    const datos = esquemaCrearPaciente.parse(req.body);
    res.status(201).json(await servicio.crear(pool, actorDe(req), datos));
  });

  router.get('/paciente/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.verFicha(pool, actorDe(req), id));
  });

  router.patch('/paciente/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    const cambios = esquemaEditarPaciente.parse(req.body);
    res.json(await servicio.editar(pool, actorDe(req), id, cambios));
  });

  router.delete('/paciente/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.darDeBaja(pool, actorDe(req), id));
  });

  router.post('/paciente/:id/reactivar', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.reactivar(pool, actorDe(req), id));
  });

  return router;
}
