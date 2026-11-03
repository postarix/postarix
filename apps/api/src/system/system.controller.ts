import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSession, CurrentSession, Public } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReportsTokenGuard } from '../mail-auth/mail-auth.controller.js';
import { type ReportingService, reportingServices } from './system-store.js';
import {
  heartbeatSchema,
  type QueueActionInput,
  queueActionSchema,
  type QueueItemDto,
  type ServiceStatusDto,
  SystemService,
} from './system.service.js';

const servicePipe = new ZodValidationPipe(z.enum(reportingServices));

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** "path usedBytes totalBytes", as the reporters send it. */
function parseDisk(value: string | null) {
  const match = value?.match(/^(\S{1,200}) (\d+) (\d+)$/);
  return match ? { path: match[1]!, usedBytes: Number(match[2]), totalBytes: Number(match[3]) } : null;
}

/**
 * Where the mail containers report: new log lines every 15 seconds (with
 * their version, host and disk use in headers), and Postfix's queue, which
 * gets back the queue actions waiting for it. Never exposed through the
 * reverse proxy.
 */
@Controller('internal/reports')
@Public()
@UseGuards(ReportsTokenGuard)
export class SystemReportsController {
  constructor(@Inject(SystemService) private readonly system: SystemService) {}

  @Post('postfix/queue')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async queue(@Body() body: unknown): Promise<string> {
    const actions = await this.system.reportQueue(typeof body === 'string' ? body : '');
    return actions.map((a) => `${a}\n`).join('');
  }

  @Post(':service')
  @HttpCode(204)
  async report(@Param('service', servicePipe) service: ReportingService, @Body() body: unknown, @Req() req: Request): Promise<void> {
    const heartbeat = heartbeatSchema.parse({
      version: header(req, 'x-postarix-version'),
      host: header(req, 'x-postarix-host'),
      disk: parseDisk(header(req, 'x-postarix-disk')),
    });
    await this.system.report(service, typeof body === 'string' ? body : '', heartbeat);
  }
}

/** Instance administrators: the services' state, their logs and the mail queue. */
@Controller('system')
@UseGuards(SuperAdminGuard)
export class SystemController {
  constructor(
    @Inject(SystemService) private readonly system: SystemService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('status')
  async status(): Promise<{ data: ServiceStatusDto[] }> {
    return { data: await this.system.status() };
  }

  @Get('logs/:service')
  async logs(
    @Param('service', servicePipe) service: ReportingService,
    @Query(new ZodValidationPipe(z.object({ limit: z.coerce.number().int().min(1).max(5000).default(300), filter: z.string().max(200).optional() })))
    query: { limit: number; filter?: string },
  ): Promise<{ data: string[] }> {
    return { data: await this.system.logs(service, query.limit, query.filter) };
  }

  @Get('queue')
  queue(): Promise<{ at: string | null; items: QueueItemDto[] }> {
    return this.system.queue();
  }

  @Post('queue')
  @HttpCode(202)
  async queueAction(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(queueActionSchema)) body: QueueActionInput,
    @Req() req: Request,
  ): Promise<void> {
    await this.system.queueAction(body);
    await this.audit.recordInstance(
      { userId: session.user.id, userEmail: session.user.email, ipAddress: req.ip ?? null },
      `mail_queue.${body.action}`,
      { type: 'mail_queue', label: 'ids' in body ? body.ids.join(', ').slice(0, 500) : 'all' },
    );
  }
}
