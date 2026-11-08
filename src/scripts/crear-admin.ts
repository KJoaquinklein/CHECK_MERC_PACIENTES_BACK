import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { ZodError } from 'zod';
import { crearPool } from '../db/pool.js';
import { conTransaccion } from '../db/tx.js';
import { registrarAuditoria } from '../modules/auditoria/auditoria.service.js';
import { esquemaNombreUsuario, esquemaPasswordNueva } from '../modules/auth/auth.schemas.js';
import { hashearPassword } from '../modules/auth/password.js';
import { esViolacionUnicidad } from '../modules/comun/sql.js';

// Crea el primer administrador pidiendo los datos por consola. No hay credenciales por defecto.
// Uso: npm run crear-admin   (usa DATABASE_URL, la conexión de la aplicación)

const { DATABASE_URL, DATABASE_SSL } = process.env;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

let silenciado = false;
const salida = new Writable({
  write(chunk, _codificacion, listo) {
    if (!silenciado) process.stdout.write(chunk);
    listo();
  },
});
const consola = createInterface({ input: process.stdin, output: salida, terminal: true });

function preguntar(texto: string, oculto = false): Promise<string> {
  return new Promise((resolver) => {
    process.stdout.write(texto);
    silenciado = oculto;
    consola.question('', (respuesta) => {
      silenciado = false;
      if (oculto) process.stdout.write('\n');
      resolver(respuesta);
    });
  });
}

const pool = crearPool({ DATABASE_URL, DATABASE_SSL: DATABASE_SSL === 'true' });
try {
  const nombreUsuario = esquemaNombreUsuario.parse(await preguntar('Nombre de usuario: '));
  const nombreCompleto = (await preguntar('Nombre completo: ')).trim();
  if (!nombreCompleto) throw new Error('El nombre completo no puede estar vacío.');
  const password = esquemaPasswordNueva.parse(await preguntar('Contraseña: ', true));
  const repeticion = await preguntar('Repetir contraseña: ', true);
  if (password !== repeticion) throw new Error('Las contraseñas no coinciden.');

  const hash = await hashearPassword(password);
  const usuario = await conTransaccion(pool, async (cliente) => {
    const { rows } = await cliente.query<{ id: number }>(
      `INSERT INTO usuario (nombre_usuario, nombre_completo, rol, password_hash)
       VALUES ($1, $2, 'admin', $3) RETURNING id`,
      [nombreUsuario, nombreCompleto, hash],
    );
    const id = rows[0]!.id;
    await registrarAuditoria(cliente, {
      accion: 'usuario_crear',
      entidad: 'usuario',
      entidadId: id,
      detalle: { rol: 'admin', origen: 'script crear-admin' },
    });
    return { id };
  });
  console.log(`Administrador "${nombreUsuario}" creado (id ${usuario.id}).`);
} catch (error) {
  if (esViolacionUnicidad(error)) console.error('Ya existe un usuario con ese nombre.');
  else if (error instanceof ZodError) console.error(error.issues.map((i) => i.message).join(' | '));
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  consola.close();
  await pool.end();
}
