import { pipeline } from 'node:stream/promises';
import { Router, type Request, type RequestHandler } from 'express';
import type pg from 'pg';
import type { Env } from '../../config/env.js';
import type { StorageDriver } from '../../storage/driver.js';
import { ipDe } from '../auditoria/auditoria.service.js';
import { esquemaParamsId } from '../comun/sql.js';
import {
  esquemaCamposSubida,
  esquemaEditarArchivo,
  esquemaListarArchivos,
} from './archivos.schemas.js';
import * as servicio from './archivos.service.js';
import { recibirSubida } from './subida.js';

export function crearArchivosRouter(deps: {
  pool: pg.Pool;
  storage: StorageDriver;
  env: Pick<Env, 'MAX_UPLOAD_MB' | 'DOWNLOAD_MODE' | 'SIGNED_URL_TTL_SECONDS'>;
  autenticar: RequestHandler;
}): Router {
  const { pool, storage, env } = deps;
  const router = Router();
  // La sesión se valida antes de leer una sola parte de la subida
  router.use(deps.autenticar);

  const actorDe = (req: Request): servicio.Actor => ({ id: req.usuario!.id, ip: ipDe(req) });
  const maxBytes = Math.floor(env.MAX_UPLOAD_MB * 1024 * 1024);

  router.get('/', async (req, res) => {
    res.json(await servicio.listar(pool, esquemaListarArchivos.parse(req.query)));
  });

  router.post('/', async (req, res) => {
    let subida;
    try {
      subida = await recibirSubida(req, { maxBytes });
    } catch (error) {
      // Si se rechaza en medio de la transferencia, se cierra la conexión en vez de seguir leyendo
      res.setHeader('Connection', 'close');
      throw error;
    }
    try {
      const campos = esquemaCamposSubida.parse(subida.campos);
      const archivo = await servicio.subir(
        { pool, storage, log: req.log },
        actorDe(req),
        campos,
        subida.archivo,
      );
      res.status(201).json(archivo);
    } finally {
      await subida.limpiar();
    }
  });

  router.get('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.ver(pool, actorDe(req), id));
  });

  router.get('/:id/contenido', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    const descarga = await servicio.prepararDescarga(
      {
        pool,
        storage,
        log: req.log,
        modo: env.DOWNLOAD_MODE,
        ttlSegundos: env.SIGNED_URL_TTL_SECONDS,
      },
      actorDe(req),
      id,
    );

    // Los archivos médicos nunca se guardan en cachés compartidas ni del navegador
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (descarga.modo === 'redirect') {
      res.redirect(302, descarga.url);
      return;
    }

    const { archivo, stream, disposicion } = descarga;
    res.status(200);
    // El tipo sale de la base (validado al subir), nunca del nombre del archivo
    res.setHeader('Content-Type', archivo.mime_type);
    res.setHeader('Content-Length', String(archivo.tamano_bytes));
    res.setHeader('Content-Disposition', disposicion);
    // Si alguien abre el archivo directamente, no puede ejecutar scripts ni cargar recursos
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // El frontend y la API comparten dominio registrable: permite incrustarlo desde el frontend
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    try {
      await pipeline(stream, res);
    } catch (error) {
      // El cliente cortó la descarga: no es un error del servidor
      if ((error as { code?: string }).code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
    }
  });

  router.patch('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    const cambios = esquemaEditarArchivo.parse(req.body);
    res.json(await servicio.editar(pool, actorDe(req), id, cambios));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.darDeBaja(pool, actorDe(req), id));
  });

  router.post('/:id/restaurar', async (req, res) => {
    const { id } = esquemaParamsId.parse(req.params);
    res.json(await servicio.restaurar(pool, actorDe(req), id));
  });

  return router;
}
