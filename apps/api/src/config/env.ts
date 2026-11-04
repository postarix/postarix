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

/** Comma-separated web origins ("https://host[:port]"), checked at start. */
const originList = commaList.superRefine((items, ctx) => {
  for (const item of items) {
    let url: URL | undefined;
    try {
      url = new URL(item);
    } catch {
      url = undefined;
    }
    if (!url || !/^https?:$/.test(url.protocol) || url.origin !== item.replace(/\/$/, '')) {
      ctx.addIssue({
        code: 'custom',
        message: `"${item}" is not an origin such as https://mail.example.com (a proxy's address or network goes in TRUSTED_PROXIES)`,
      });
    }
  }
});

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    /** Port of the Prometheus metrics listener (/metrics). Unset: no metrics. Never route it through the reverse proxy. */
    METRICS_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
    /** "json" writes one JSON object per log line (for Loki, Elasticsearch…). */
    LOG_FORMAT: z.enum(['text', 'json']).default('text'),
    DATABASE_URL: z.url(),
    /** Public base URL of the API, used by Better Auth for callbacks and cookies. */
    AUTH_URL: z.url(),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    /** Browser origins allowed to call the API with credentials (admin, webmail). */
    TRUSTED_ORIGINS: originList,
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
    /** Cyrus' internal JMAP service (for the webmail), e.g. https://cyrus:8008 (TLS checked like CYRUS_HOST). Unset disables the webmail API. */
    CYRUS_JMAP_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Postfix's internal submission port, used to send webmail messages (logs in with INTERNAL_API_TOKEN). */
    SUBMISSION_HOST: z.string().default('postfix'),
    SUBMISSION_PORT: z.coerce.number().int().positive().default(10587),
    /** Largest attachment or message accepted through the webmail, in bytes (default 50 MiB, like Postfix). */
    MAIL_UPLOAD_LIMIT: z.coerce.number().int().positive().default(50 * 1024 * 1024),
    /**
     * Cyrus Murder: the backends mailboxes are spread over, as
     * "name=host,name=host" (each one's admin IMAP is host:CYRUS_PORT and its
     * JMAP https://host:8008). Unset: a single Cyrus (CYRUS_HOST,
     * CYRUS_JMAP_URL). See docs/SCALING.md.
     */
    CYRUS_BACKENDS: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (!value?.trim()) return [];
        const backends = value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
          const [name, host] = entry.split('=').map((part) => part.trim());
          return { name: name ?? '', host: host ?? '' };
        });
        for (const backend of backends) {
          if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(backend.name) || !/^[A-Za-z0-9.-]+$/.test(backend.host)) {
            ctx.addIssue({ code: 'custom', message: 'Expected "name=host,name=host" (names: lowercase letters, digits, dashes)' });
            return z.NEVER;
          }
        }
        if (new Set(backends.map((b) => b.name)).size !== backends.length) {
          ctx.addIssue({ code: 'custom', message: 'Backend names must be unique' });
          return z.NEVER;
        }
        return backends;
      }),
    /** Murder: the backend of mailboxes created before the Murder (default: the first one). */
    CYRUS_DEFAULT_BACKEND: z.string().optional(),
    CYRUS_ADMIN_USER: z.string().default('cyrus'),
    CYRUS_ADMIN_PASSWORD: z.string().optional(),

    /**
     * Shared secret for /api/internal/* (the mail login bridge). When unset,
     * the internal endpoints are disabled.
     */
    INTERNAL_API_TOKEN: z.string().min(32, 'INTERNAL_API_TOKEN must be at least 32 characters').optional(),
    /** The mail-login bridge's secret (the Cyrus containers have it too). Default: derived from INTERNAL_API_TOKEN. */
    POSTARIX_SECRET_MAIL_AUTH: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
    /** The password of Postfix's internal submission port (Postfix has it too). Default: derived from INTERNAL_API_TOKEN. */
    POSTARIX_SECRET_SUBMISSION: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
    /** The secret mail containers send their logs and queue with (they have it too). Default: derived from INTERNAL_API_TOKEN. */
    POSTARIX_SECRET_REPORTS: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
    /**
     * The internal HTTPS listener for the mail-login bridge (/api/internal/*),
     * so mail passwords never cross the network in clear. When the key and
     * certificate are set, /api/internal/* answers on this port only.
     */
    INTERNAL_TLS_PORT: z.coerce.number().int().positive().default(3443),
    INTERNAL_TLS_CERT_FILE: z.string().optional(),
    INTERNAL_TLS_KEY_FILE: z.string().optional(),

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
    /**
     * Mail import from other servers: hosts on a private network that may be
     * imported from (an old server next to this one). Public servers need no entry.
     */
    MAIL_IMPORT_ALLOWED_HOSTS: commaList,
    /** PEM file of extra certificates trusted for mail import (a private CA). */
    MAIL_IMPORT_CA_FILE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    /** Rspamd's controller (e.g. http://rspamd:11334), for the filtering history. Unset hides it. */
    RSPAMD_CONTROLLER_URL: z.url({ protocol: /^https?$/ }).optional(),
    RSPAMD_CONTROLLER_PASSWORD: z.string().optional(),
    /** Rspamd's write password: with it, Rspamd's web interface (System → Rspamd) can also learn and change settings. */
    RSPAMD_CONTROLLER_ENABLE_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    /** Public name of the mail server, used in the DNS records shown to admins (MX target). */
    MAIL_HOSTNAME: z.string().min(1).default('localhost'),
    /** Sender of the server's own notices (e.g. "you were added to an organization"). Default no-reply@MAIL_HOSTNAME. */
    SYSTEM_MAIL_FROM: z.preprocess((value) => (value === '' ? undefined : value), z.email().optional()),
    /**
     * Valkey URL (redis://:password@host:6379). DKIM keys are published there for
     * Rspamd. Without it keys are kept in memory and nothing is signed.
     */
    VALKEY_URL: z.string().optional(),
    /** Days refused spam is kept in quarantine for its recipients. */
    QUARANTINE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
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
  .refine((env) => !env.CYRUS_DEFAULT_BACKEND || env.CYRUS_BACKENDS.some((b) => b.name === env.CYRUS_DEFAULT_BACKEND), {
    path: ['CYRUS_DEFAULT_BACKEND'],
    message: 'CYRUS_DEFAULT_BACKEND must be one of CYRUS_BACKENDS',
  })
  .refine((env) => env.NODE_ENV !== 'production' || !env.CYRUS_JMAP_URL || env.CYRUS_JMAP_URL.startsWith('https:'), {
    path: ['CYRUS_JMAP_URL'],
    message: 'must use https in production (mail tokens cross the network)',
  })
  .refine((env) => env.NODE_ENV !== 'production' || !(env.INTERNAL_API_TOKEN || env.POSTARIX_SECRET_MAIL_AUTH) || (env.INTERNAL_TLS_CERT_FILE && env.INTERNAL_TLS_KEY_FILE), {
    path: ['INTERNAL_TLS_KEY_FILE'],
    message: 'INTERNAL_TLS_CERT_FILE and INTERNAL_TLS_KEY_FILE are required in production (mail passwords cross the network)',
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
