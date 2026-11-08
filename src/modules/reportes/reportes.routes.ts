import { Router, type RequestHandler, type Response } from 'express';
import type pg from 'pg';
import { aCsv } from '../comun/csv.js';
import * as repo from './reportes.repo.js';
import {
  esquemaPeriodo,
  esquemaRankingPacientes,
  esquemaSoloFormato,
  type Formato,
} from './reportes.schemas.js';

/** Responde en JSON (`{ data }`) o como CSV descargable con las columnas indicadas. */
function responder(
  res: Response,
  formato: Formato,
  nombre: string,
  columnas: readonly string[],
  filas: readonly object[],
  separador: string,
) {
  if (formato === 'json') {
    res.json({ data: filas });
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(aCsv(columnas, filas as Record<string, unknown>[], separador));
}

/** Reportes de solo lectura, disponibles para cualquier usuario autenticado. */
export function crearReportesRouter(deps: {
  pool: pg.Pool;
  autenticar: RequestHandler;
  csvSeparador: string;
}): Router {
  const { pool, csvSeparador } = deps;
  const router = Router();
  router.use(deps.autenticar);

  router.get('/resumen', async (req, res) => {
    const { formato } = esquemaSoloFormato.parse(req.query);
    const resumen = await repo.resumenGeneral(pool);
    if (formato === 'json') {
      res.json(resumen);
      return;
    }
    const filas = Object.entries(resumen).map(([indicador, valor]) => ({ indicador, valor }));
    responder(res, formato, 'resumen', ['indicador', 'valor'], filas, csvSeparador);
  });

  router.get('/consultas-por-mes', async (req, res) => {
    const { formato, ...periodo } = esquemaPeriodo.parse(req.query);
    const filas = await repo.consultasPorMes(pool, periodo);
    responder(res, formato, 'consultas-por-mes', ['mes', 'consultas'], filas, csvSeparador);
  });

  router.get('/pacientes-nuevos-por-mes', async (req, res) => {
    const { formato, ...periodo } = esquemaPeriodo.parse(req.query);
    const filas = await repo.pacientesNuevosPorMes(pool, periodo);
    responder(
      res,
      formato,
      'pacientes-nuevos-por-mes',
      ['mes', 'pacientes_nuevos'],
      filas,
      csvSeparador,
    );
  });

  router.get('/ediciones-por-mes', async (req, res) => {
    const { formato, ...periodo } = esquemaPeriodo.parse(req.query);
    const filas = await repo.edicionesPorMes(pool, periodo);
    responder(
      res,
      formato,
      'ediciones-por-mes',
      ['mes', 'ediciones', 'consultas_modificadas'],
      filas,
      csvSeparador,
    );
  });

  router.get('/pacientes-por-obra-social', async (req, res) => {
    const { formato } = esquemaSoloFormato.parse(req.query);
    const filas = await repo.pacientesPorObraSocial(pool);
    responder(
      res,
      formato,
      'pacientes-por-obra-social',
      ['id_obra_social', 'nombre', 'cantidad'],
      filas,
      csvSeparador,
    );
  });

  router.get('/consultas-por-paciente', async (req, res) => {
    const { formato, limit, ...periodo } = esquemaRankingPacientes.parse(req.query);
    const filas = await repo.consultasPorPaciente(pool, periodo, limit);
    responder(
      res,
      formato,
      'consultas-por-paciente',
      ['id_paciente', 'nombre_completo', 'consultas', 'ultima_consulta'],
      filas,
      csvSeparador,
    );
  });

  return router;
}
