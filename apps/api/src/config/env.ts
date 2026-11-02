import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const commaList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  /** Public base URL of the API, used by Better Auth for callbacks and cookies. */
  AUTH_URL: z.url(),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  /** Browser origins allowed to call the API with credentials (admin, webmail). */
  TRUSTED_ORIGINS: commaList,
  /**
   * Reverse proxies whose X-Forwarded-For header is trusted (IPs or CIDRs).
   * Empty means the API is reached directly and forwarded headers are ignored.
   */
  TRUSTED_PROXIES: commaList,
  /** Public self-registration. Off by default: accounts are created by admins. */
  ALLOW_SIGNUP: booleanFromString,
  /** Whether regular users may create organizations. Off by default. */
  ALLOW_USER_CREATE_ORG: booleanFromString,
}).refine((env) => env.NODE_ENV === 'production' || !env.AUTH_URL.startsWith('https:'), {
  // An unset NODE_ENV means "development", which relaxes library fallbacks.
  // A public HTTPS deployment must say so explicitly.
  path: ['NODE_ENV'],
  message: 'must be "production" when AUTH_URL uses https',
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
