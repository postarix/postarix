import { Body, Controller, Get, Inject, Injectable, Module, Put, Req, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSession, CurrentSession, Public } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { instanceSettings } from '../db/schema/index.js';
import { normalizeDomainName } from '../domains/domain-name.js';

const singleLine = (max: number) => z.string().trim().max(max).regex(/^[^\r\n]*$/, 'Use a single line');

/** Everything instance administrators can change at run time, with its defaults. */
export const settingsSchema = z.object({
  signIn: z
    .object({
      /** Failed passwords (web or mail apps) after which an account is locked for a while. */
      maxFailures: z.number().int().min(3).max(100).default(10),
      lockMinutes: z.number().int().min(1).max(1440).default(15),
    })
    .default({ maxFailures: 10, lockMinutes: 15 }),
  passwords: z
    .object({
      minLength: z.number().int().min(12).max(128).default(12),
      /** Require lowercase, uppercase, digits and symbols (three of the four). */
      requireMixed: z.boolean().default(false),
    })
    .default({ minLength: 12, requireMixed: false }),
  quota: z
    .object({
      /** Tell people when their mailbox is this full (percent); 0 never. */
      warnAtPercent: z.number().int().min(0).max(100).default(90),
      /** The notice: its sender (empty: SYSTEM_MAIL_FROM), subject and text ({address}, {percent}, {used}, {quota}; empty: the default). */
      sender: z.union([z.literal(''), z.email()]).default(''),
      subject: singleLine(200).default(''),
      template: z.string().max(5000).default(''),
    })
    .default({ warnAtPercent: 90, sender: '', subject: '', template: '' }),
  quarantine: z
    .object({
      /** Days refused spam is kept; null: QUARANTINE_RETENTION_DAYS (30 by default). */
      retentionDays: z.number().int().min(1).max(365).nullable().default(null),
      /** Larger messages are refused without being kept (bytes; 0: keep none). */
      maxBytes: z.number().int().min(0).max(100 * 1024 * 1024).default(10 * 1024 * 1024),
      /** No notice for messages scoring above this (obvious spam); null: always. */
      notifyMaxScore: z.number().min(0).max(1000).nullable().default(null),
      /** Send every notice to this address instead of the recipients; empty: the recipients. */
      redirectTo: z.union([z.literal(''), z.email()]).default(''),
      /** A blind copy of every notice; empty: none. */
      bccTo: z.union([z.literal(''), z.email()]).default(''),
      sender: z.union([z.literal(''), z.email()]).default(''),
      subject: singleLine(200).default(''),
      /** A released message arrives as it was, or attached to a short note. */
      releaseFormat: z.enum(['original', 'attachment']).default('original'),
      /** Domains whose mail is never kept (refused spam is just refused). */
      excludedDomains: z
        .array(
          z
            .string()
            .max(253)
            .transform((value, ctx) => {
              const name = normalizeDomainName(value);
              if (!name) {
                ctx.addIssue({ code: 'custom', message: 'Use domain names such as example.com' });
                return z.NEVER;
              }
              return name;
            }),
        )
        .max(500)
        .default([]),
    })
    .default({
      retentionDays: null,
      maxBytes: 10 * 1024 * 1024,
      notifyMaxScore: null,
      redirectTo: '',
      bccTo: '',
      sender: '',
      subject: '',
      releaseFormat: 'original',
      excludedDomains: [],
    }),
  branding: z
    .object({
      /** Shown in the page titles and the sign-in page. */
      productName: singleLine(60).min(1).default('Postarix'),
      /** A line on the sign-in pages (e.g. who to call for help). */
      loginMessage: z.string().trim().max(500).default(''),
      /** A notice shown to everyone signed in (e.g. planned maintenance); empty for none. */
      announcement: z.string().trim().max(500).default(''),
      /** Where people get help. */
      supportUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
      /** How prominent the announcement is. */
      announcementLevel: z.enum(['info', 'important', 'urgent']).default('important'),
      /** A line at the bottom of the sign-in pages. */
      footer: z.string().trim().max(500).default(''),
      /** A logo instead of the stamp: a PNG, JPEG, WebP or SVG image as a data: URL (at most ~200 kB). */
      logo: z
        .union([
          z.literal(''),
          z
            .string()
            .max(280_000)
            .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, 'Use a PNG, JPEG, WebP or SVG image'),
        ])
        .default(''),
      /** More apps, shown in the Apps menus of the admin panel and the webmail. */
      appLinks: z
        .array(z.object({ name: singleLine(40).min(1), url: z.url({ protocol: /^https?$/ }) }))
        .max(12)
        .default([]),
      /** Only single sign-on on the sign-in page (the password form stays reachable at ?password=1). */
      hidePasswordSignIn: z.boolean().default(false),
    })
    .default({
      productName: 'Postarix',
      loginMessage: '',
      announcement: '',
      supportUrl: '',
      announcementLevel: 'important',
      footer: '',
      logo: '',
      appLinks: [],
      hidePasswordSignIn: false,
    }),
});
export type InstanceSettings = z.infer<typeof settingsSchema>;

/** A change: any subset of sections, each complete or partial. */
export const settingsUpdateSchema = z.strictObject({
  signIn: settingsSchema.shape.signIn.unwrap().partial().strict().optional(),
  passwords: settingsSchema.shape.passwords.unwrap().partial().strict().optional(),
  quota: settingsSchema.shape.quota.unwrap().partial().strict().optional(),
  quarantine: settingsSchema.shape.quarantine.unwrap().partial().strict().optional(),
  branding: settingsSchema.shape.branding.unwrap().partial().strict().optional(),
});
export type InstanceSettingsUpdate = z.infer<typeof settingsUpdateSchema>;

const CACHE_MS = 15_000;
let cache: { value: InstanceSettings; expires: number } | null = null;

/**
 * The current settings, read at most every few seconds per API instance (so
 * a change reaches every instance quickly). Usable outside Nest's DI, e.g.
 * by Better Auth's hooks.
 */
export async function loadInstanceSettings(db: Database): Promise<InstanceSettings> {
  if (cache && cache.expires > Date.now()) return cache.value;
  let stored: Record<string, unknown> = {};
  try {
    const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
    stored = row?.settings ?? {};
  } catch {
    // The database is unreachable: the defaults (or the last values) hold.
    if (cache) return cache.value;
  }
  const parsed = settingsSchema.safeParse(stored);
  const value = parsed.success ? parsed.data : settingsSchema.parse({});
  cache = { value, expires: Date.now() + CACHE_MS };
  return value;
}

/** Whether a password meets the instance's policy; the reason when it does not. */
export function passwordProblem(password: string, policy: InstanceSettings['passwords']): string | null {
  if (password.length < policy.minLength) return `Use at least ${policy.minLength} characters`;
  if (policy.requireMixed) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
    if (classes < 3) return 'Mix at least three of: lowercase letters, uppercase letters, digits and symbols';
  }
  return null;
}

@Injectable()
export class InstanceSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  get(): Promise<InstanceSettings> {
    return loadInstanceSettings(this.db);
  }

  async update(session: AuthSession, ipAddress: string | null, change: InstanceSettingsUpdate): Promise<InstanceSettings> {
    const current = await this.get();
    const next = settingsSchema.parse({
      signIn: { ...current.signIn, ...change.signIn },
      passwords: { ...current.passwords, ...change.passwords },
      quota: { ...current.quota, ...change.quota },
      quarantine: { ...current.quarantine, ...change.quarantine },
      branding: { ...current.branding, ...change.branding },
    });
    await this.db
      .insert(instanceSettings)
      .values({ id: 1, settings: next })
      .onConflictDoUpdate({ target: instanceSettings.id, set: { settings: next } });
    cache = null;
    await this.audit.recordInstance(
      { userId: session.user.id, userEmail: session.user.email, ipAddress },
      'instance.settings_changed',
      { type: 'instance', label: Object.keys(change).join(', ') },
      change as Record<string, unknown>,
    );
    return next;
  }
}

@Controller()
export class InstanceSettingsController {
  constructor(@Inject(InstanceSettingsService) private readonly settings: InstanceSettingsService) {}

  @Get('system/settings')
  @UseGuards(SuperAdminGuard)
  get(): Promise<InstanceSettings> {
    return this.settings.get();
  }

  @Put('system/settings')
  @UseGuards(SuperAdminGuard)
  update(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(settingsUpdateSchema)) body: InstanceSettingsUpdate,
  ): Promise<InstanceSettings> {
    return this.settings.update(session, req.ip ?? null, body);
  }

  /** What the sign-in pages and the apps show before (and after) signing in. */
  @Get('branding')
  @Public()
  async branding(): Promise<InstanceSettings['branding'] & { passwordMinLength: number }> {
    const settings = await this.settings.get();
    return { ...settings.branding, passwordMinLength: settings.passwords.minLength };
  }
}

@Module({
  controllers: [InstanceSettingsController],
  providers: [InstanceSettingsService],
  exports: [InstanceSettingsService],
})
export class InstanceSettingsModule {}
