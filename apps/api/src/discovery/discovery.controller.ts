import { Controller, Get, Header, Inject, NotFoundException, Post, Query, Req, Res } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Public } from '../auth/session.js';
import type { Env } from '../config/env.js';
import { DATABASE, ENV } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { domains } from '../db/schema/index.js';
import { autoconfigXml, autodiscoverXml, domainOfAddress, emailFromAutodiscoverRequest, type MtaStsMode, mtaStsPolicy } from './discovery.js';

/**
 * Public endpoints that mail software fetches by itself: Thunderbird's
 * autoconfig, Outlook's Autodiscover and the MTA-STS policy. They answer only
 * for verified domains hosted here, and contain nothing but server settings.
 * They live outside /api (see bootstrap) because clients use fixed paths.
 */
@Controller()
export class DiscoveryController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The active domain, if its mail is hosted here (not a backup MX domain). */
  private async hosted(domain: string | null): Promise<{ mtaStsMode: MtaStsMode | null } | undefined> {
    if (!domain) return undefined;
    const [row] = await this.db
      .select({ mtaStsMode: domains.mtaStsMode })
      .from(domains)
      .where(and(eq(domains.name, domain), eq(domains.status, 'active'), eq(domains.backupMx, false)))
      .limit(1);
    return row;
  }

  private async isHosted(domain: string | null): Promise<boolean> {
    return Boolean(await this.hosted(domain));
  }

  /** The user's domain: from ?emailaddress=, else from the host (autoconfig.<domain>). */
  private async autoconfig(req: Request, email: unknown): Promise<string> {
    // A repeated parameter arrives as an array: only a single address counts.
    const fromEmail = typeof email === 'string' && email ? domainOfAddress(email) : null;
    const fromHost = req.hostname.toLowerCase().replace(/^autoconfig\./, '');
    const domain = fromEmail ?? fromHost;
    if (!(await this.isHosted(domain))) throw new NotFoundException();
    return autoconfigXml(domain, this.env.MAIL_HOSTNAME);
  }

  @Public()
  @Get('.well-known/autoconfig/mail/config-v1.1.xml')
  @Header('content-type', 'application/xml; charset=utf-8')
  @Header('cache-control', 'public, max-age=3600')
  @Header('vary', 'host')
  wellKnownAutoconfig(@Req() req: Request, @Query('emailaddress') email?: unknown): Promise<string> {
    return this.autoconfig(req, email);
  }

  @Public()
  @Get('mail/config-v1.1.xml')
  @Header('content-type', 'application/xml; charset=utf-8')
  @Header('cache-control', 'public, max-age=3600')
  @Header('vary', 'host')
  hostAutoconfig(@Req() req: Request, @Query('emailaddress') email?: unknown): Promise<string> {
    return this.autoconfig(req, email);
  }

  @Public()
  @Post('autodiscover/autodiscover.xml')
  async autodiscover(@Req() req: Request, @Res() res: Response): Promise<void> {
    // Outlook posts a small XML document (parsed as text by the body limiter).
    const body = typeof req.body === 'string' ? req.body : '';
    const email = emailFromAutodiscoverRequest(body);
    if (!email || !(await this.isHosted(domainOfAddress(email)))) {
      res.status(404).end();
      return;
    }
    res.status(200).type('application/xml; charset=utf-8').send(autodiscoverXml(email, this.env.MAIL_HOSTNAME));
  }

  /** https://mta-sts.<domain>/.well-known/mta-sts.txt (RFC 8461). */
  @Public()
  @Get('.well-known/mta-sts.txt')
  @Header('content-type', 'text/plain; charset=utf-8')
  @Header('cache-control', 'public, max-age=3600')
  async mtaSts(@Req() req: Request): Promise<string> {
    const host = req.hostname.toLowerCase();
    const domain = host.startsWith('mta-sts.') ? await this.hosted(host.slice('mta-sts.'.length)) : undefined;
    if (!domain) throw new NotFoundException();
    return mtaStsPolicy(domain.mtaStsMode ?? this.env.MTA_STS_MODE, this.env.MAIL_HOSTNAME);
  }

  /**
   * /api/tls/allowed?domain=…: whether the reverse proxy may obtain a
   * certificate for this name on demand (Caddy's on_demand_tls "ask"). Only
   * the mail hostname and the autoconfig./mta-sts. names of hosted domains,
   * so nobody can make the proxy request certificates for arbitrary names.
   */
  @Public()
  @Get('tls/allowed')
  @Header('cache-control', 'no-store')
  async tlsAllowed(@Query('domain') domain: unknown): Promise<string> {
    const name = typeof domain === 'string' ? domain.trim().toLowerCase().replace(/\.$/, '') : '';
    if (name && name === this.env.MAIL_HOSTNAME.toLowerCase()) return 'ok';
    const match = /^(?:autoconfig|mta-sts)\.(.+)$/.exec(name);
    if (match && (await this.isHosted(match[1]!))) return 'ok';
    throw new NotFoundException();
  }
}
