import { z } from 'zod';

const booleanFromString = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
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

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    /** Public base URL of the API, used by Better Auth for callbacks and cookies. */
    AUTH_URL: z.url(),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    /** Browser origins allowed to call the API with credentials (admin, webmail). */
    TRUSTED_ORIGINS: commaList,
    /**
     * Origins of identity providers on a private network that organizations
     * may use for single sign-on (e.g. https://idp.corp.internal). Public https
     * providers need no entry. These origins are trusted on the sign-in routes
     * only, never as browser origins for the rest of the API.
     */
    SSO_TRUSTED_ISSUERS: commaList,
    /**
     * Reverse proxies whose X-Forwarded-For header is trusted (IPs or CIDRs).
     * Empty means the API is reached directly and forwarded headers are ignored.
     */
    TRUSTED_PROXIES: commaList,
    /** Public self-registration. Off by default: accounts are created by admins. */
    ALLOW_SIGNUP: booleanFromString('false'),
    /** Whether regular users may create organizations. Off by default. */
    ALLOW_USER_CREATE_ORG: booleanFromString('false'),

    /** Mailbox engine. "memory" keeps mailboxes in RAM (tests, UI development). */
    MAIL_ENGINE: z.enum(['cyrus', 'memory']).default('cyrus'),
    CYRUS_HOST: z.string().default('cyrus'),
    CYRUS_PORT: z.coerce.number().int().positive().default(143),
    CYRUS_SECURITY: z.enum(['tls', 'starttls', 'none']).default('starttls'),
    /** Verify Cyrus' certificate. Disable only for local development. */
    CYRUS_TLS_VERIFY: booleanFromString('true'),
    /** Name Cyrus' certificate must carry when it differs from CYRUS_HOST (the public mail hostname). */
    CYRUS_TLS_SERVERNAME: z.string().optional(),
    /**
     * PEM file with extra trusted certificates, re-read on every connection.
     * Pointing it at Cyrus' own certificate (the shared certs volume) pins a
     * self-signed certificate; publicly trusted ones validate either way.
     */
    CYRUS_TLS_CA_FILE: z.string().optional(),
    /** Cyrus' internal JMAP service (for the webmail), e.g. http://cyrus:8008. Unset disables the webmail API. */
    CYRUS_JMAP_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Postfix's internal submission port, used to send webmail messages (logs in with INTERNAL_API_TOKEN). */
    SUBMISSION_HOST: z.string().default('postfix'),
    SUBMISSION_PORT: z.coerce.number().int().positive().default(10587),
    /** Largest attachment or message accepted through the webmail, in bytes (default 50 MiB, like Postfix). */
    MAIL_UPLOAD_LIMIT: z.coerce.number().int().positive().default(50 * 1024 * 1024),
    CYRUS_ADMIN_USER: z.string().default('cyrus'),
    CYRUS_ADMIN_PASSWORD: z.string().optional(),

    /**
     * Shared secret for /api/internal/* (the mail login bridge). When unset,
     * the internal endpoints are disabled.
     */
    INTERNAL_API_TOKEN: z.string().min(32, 'INTERNAL_API_TOKEN must be at least 32 characters').optional(),

    /** How domain ownership is proven. "skip" activates domains immediately (development only). */
    DOMAIN_VERIFICATION: z.enum(['dns', 'skip']).default('dns'),
    /** DNS resolvers used for verification (defaults to the system resolver). */
    DNS_SERVERS: commaList,

    /**
     * MTA-STS policy mode for hosted domains (RFC 8461). "testing" reports
     * problems without refusing delivery; switch to "enforce" once every
     * domain's mta-sts host serves a valid certificate.
     */
    MTA_STS_MODE: z.enum(['enforce', 'testing', 'none']).default('testing'),
    /** Rspamd's controller (e.g. http://rspamd:11334), for the filtering history. Unset hides it. */
    RSPAMD_CONTROLLER_URL: z.url({ protocol: /^https?$/ }).optional(),
    RSPAMD_CONTROLLER_PASSWORD: z.string().optional(),
    /** Public name of the mail server, used in the DNS records shown to admins (MX target). */
    MAIL_HOSTNAME: z.string().min(1).default('localhost'),
    /** Sender of the server's own notices (e.g. "you were added to an organization"). Default no-reply@MAIL_HOSTNAME. */
    SYSTEM_MAIL_FROM: z.preprocess((value) => (value === '' ? undefined : value), z.email().optional()),
    /**
     * Valkey URL (redis://:password@host:6379). DKIM keys are published there for
     * Rspamd. Without it keys are kept in memory and nothing is signed.
     */
    VALKEY_URL: z.string().optional(),
  })
  .refine((env) => env.NODE_ENV === 'production' || !env.AUTH_URL.startsWith('https:'), {
    // An unset NODE_ENV means "development", which relaxes library fallbacks.
    // A public HTTPS deployment must say so explicitly.
    path: ['NODE_ENV'],
    message: 'must be "production" when AUTH_URL uses https',
  })
  .refine((env) => env.MAIL_ENGINE !== 'cyrus' || (env.CYRUS_ADMIN_PASSWORD ?? '').length > 0, {
    path: ['CYRUS_ADMIN_PASSWORD'],
    message: 'is required when MAIL_ENGINE is "cyrus"',
  })
  .refine((env) => env.NODE_ENV !== 'production' || (env.VALKEY_URL ?? '').length > 0, {
    path: ['VALKEY_URL'],
    message: 'is required in production (Rspamd reads DKIM keys from Valkey)',
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.DOMAIN_VERIFICATION === 'dns', {
    // Skipping verification would let any tenant activate someone else's domain.
    path: ['DOMAIN_VERIFICATION'],
    message: 'must be "dns" in production',
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
