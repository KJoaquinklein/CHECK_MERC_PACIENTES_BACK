import { z } from 'zod';

const texto = (nombre: string) =>
  z
    .string({ error: `${nombre} es obligatoria` })
    .trim()
    .min(1, `${nombre} no puede estar vacía`);

const booleano = z
  .enum(['true', 'false'], { error: 'debe ser "true" o "false"' })
  .transform((valor) => valor === 'true');

const esquemaBase = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'], {
      error: 'debe ser development, test o production',
    })
    .default('development'),
  PORT: z.coerce.number({ error: 'PORT debe ser un número' }).int().min(1).max(65535).default(3000),
  API_PREFIX: z
    .string()
    .regex(/^(\/[a-zA-Z0-9_-]+)*$/, 'debe ser vacío o empezar con "/" y no terminar en "/"')
    .default(''),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
      error: 'nivel de log inválido',
    })
    .default('info'),

  DATABASE_URL: texto('DATABASE_URL').regex(/^postgres(ql)?:\/\//, 'debe empezar con postgres://'),
  DATABASE_SSL: booleano.default(false),

  CORS_ORIGINS: texto('CORS_ORIGINS').transform((valor) =>
    valor
      .split(',')
      .map((origen) => origen.trim())
      .filter(Boolean),
  ),
  TRUST_PROXY: z.coerce.number({ error: 'TRUST_PROXY debe ser un número' }).int().min(0).default(0),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),

  STORAGE_DRIVER: z.enum(['local', 's3'], { error: 'debe ser local o s3' }).default('local'),
  STORAGE_LOCAL_DIR: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  CSV_SEPARADOR: z.enum([';', ','], { error: 'debe ser ; o ,' }).default(';'),
  DOWNLOAD_MODE: z
    .enum(['stream', 'redirect'], { error: 'debe ser stream o redirect' })
    .default('stream'),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  MAX_UPLOAD_MB: z.coerce
    .number({ error: 'MAX_UPLOAD_MB debe ser un número' })
    .positive()
    .default(25),
});

const esquemaEnv = esquemaBase.superRefine((env, ctx) => {
  const exigidas =
    env.STORAGE_DRIVER === 's3'
      ? ([
          'S3_ENDPOINT',
          'S3_REGION',
          'S3_BUCKET',
          'S3_ACCESS_KEY_ID',
          'S3_SECRET_ACCESS_KEY',
        ] as const)
      : (['STORAGE_LOCAL_DIR'] as const);
  for (const nombre of exigidas) {
    if (!env[nombre]) {
      ctx.addIssue({
        code: 'custom',
        path: [nombre],
        message: `es obligatoria cuando STORAGE_DRIVER=${env.STORAGE_DRIVER}`,
      });
    }
  }
  if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER === 'local') {
    ctx.addIssue({
      code: 'custom',
      path: ['STORAGE_DRIVER'],
      message: 'el driver local no se permite en producción',
    });
  }
});

export type Env = z.infer<typeof esquemaEnv>;

export class EntornoInvalidoError extends Error {
  constructor(public readonly problemas: string[]) {
    super(`Configuración de entorno inválida:\n${problemas.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EntornoInvalidoError';
  }
}

/** Valida las variables de entorno. Nunca incluye los valores en el mensaje de error. */
export function cargarEnv(fuente: NodeJS.ProcessEnv = process.env): Env {
  const resultado = esquemaEnv.safeParse(fuente);
  if (!resultado.success) {
    throw new EntornoInvalidoError(
      resultado.error.issues.map((i) => `${i.path.join('.') || '(general)'}: ${i.message}`),
    );
  }
  return resultado.data;
}
