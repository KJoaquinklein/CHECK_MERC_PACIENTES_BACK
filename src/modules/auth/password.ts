import argon2 from 'argon2';

// Parámetros argon2id recomendados por OWASP (19 MiB, 2 iteraciones, 1 hilo)
const OPCIONES = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashearPassword(password: string): Promise<string> {
  return argon2.hash(password, OPCIONES);
}

/** Devuelve false ante cualquier hash inválido en lugar de lanzar. */
export async function verificarPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let hashRelleno: Promise<string> | undefined;

/**
 * Hash de una contraseña aleatoria. Se verifica contra él cuando el usuario no existe, para que
 * el tiempo de respuesta no revele si el usuario existe.
 */
export function obtenerHashRelleno(): Promise<string> {
  hashRelleno ??= hashearPassword(`relleno-${Math.random()}-${Date.now()}`);
  return hashRelleno;
}
