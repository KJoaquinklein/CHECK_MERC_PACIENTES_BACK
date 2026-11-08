/** Error de negocio o de entrada con código HTTP y código estable para el frontend. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errores = {
  validacion: (message: string, details?: unknown[]) =>
    new AppError(400, 'VALIDACION', message, details),
  noAutenticado: (message = 'Sesión no iniciada o vencida') =>
    new AppError(401, 'NO_AUTENTICADO', message),
  prohibido: (message = 'No tenés permiso para realizar esta acción') =>
    new AppError(403, 'PROHIBIDO', message),
  noEncontrado: (message = 'Recurso no encontrado') => new AppError(404, 'NO_ENCONTRADO', message),
  conflicto: (code: string, message: string) => new AppError(409, code, message),
  reglaDeNegocio: (code: string, message: string) => new AppError(422, code, message),
};
