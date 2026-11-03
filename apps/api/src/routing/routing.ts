import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { desc, eq, like } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { isUniqueViolation } from '../common/pg-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import {
  domains,
  relayHosts,
  type RelayHostRow,
  tlsPolicies,
  tlsPolicyLevels,
  type TlsPolicyRow,
  transportRoutes,
  type TransportRouteRow,
} from '../db/schema/index.js';
import { normalizeAddress } from '../common/addresses.js';
import { normalizeDomainName } from '../domains/domain-name.js';

/** host, host:port, [host] or [host]:port (brackets: no MX lookup). */
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(300)
  .regex(/^(\[[a-z0-9.:-]+\]|[a-z0-9.-]+)(:\d{1,5})?$/, 'Use host, host:port, [host] or [host]:port');
const usernameSchema = z
  .string()
  .max(300)
  .regex(/^[^:\r\n]*$/, 'No colon or line break');
const passwordSchema = z
  .string()
  .max(300)
  .regex(/^[^\r\n]*$/, 'No line break');

/** A domain, ".domain" (its subdomains) or an address. */
const destinationSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .transform((value, ctx) => {
    const normalized = value.includes('@')
      ? normalizeAddress(value)
      : value.startsWith('.')
        ? (() => {
            const d = normalizeDomainName(value.slice(1));
            return d ? `.${d}` : null;
          })()
        : normalizeDomainName(value);
    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use a domain, .domain for its subdomains, or an address',
      });
      return z.NEVER;
    }
    return normalized;
  });

const relayHostSchema = z.strictObject({
  host: hostSchema,
  username: usernameSchema.default(''),
  password: passwordSchema.default(''),
  enabled: z.boolean().default(true),
});
const relayHostUpdateSchema = z
  .strictObject({
    host: hostSchema.optional(),
    username: usernameSchema.optional(),
    /** Omitted: unchanged. */
    password: passwordSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const transportSchema = z.strictObject({
  destination: destinationSchema,
  nexthop: hostSchema,
  username: usernameSchema.default(''),
  password: passwordSchema.default(''),
  enabled: z.boolean().default(true),
});
const transportUpdateSchema = z
  .strictObject({
    nexthop: hostSchema.optional(),
    username: usernameSchema.optional(),
    password: passwordSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const tlsPolicySchema = z.strictObject({
  destination: z
    .string()
    .trim()
    .toLowerCase()
    .max(300)
    .regex(/^(\.?[a-z0-9.-]+|\[[a-z0-9.:-]+\](:\d{1,5})?)$/, 'Use a domain, .domain or [host]:port'),
  policy: z.enum(tlsPolicyLevels),
  /** Extra attributes, e.g. "protocols=>=TLSv1.2 match=mx.example.com". */
  parameters: z
    .string()
    .trim()
    .max(500)
    .regex(/^([a-z_]+=[^\s]+( [a-z_]+=[^\s]+)*)?$/, 'Use name=value pairs separated by spaces')
    .default(''),
  enabled: z.boolean().default(true),
});
const tlsPolicyUpdateSchema = z
  .strictObject({
    policy: z.enum(tlsPolicyLevels).optional(),
    parameters: tlsPolicySchema.shape.parameters.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const idPipe = new ZodValidationPipe(z.uuid());

export interface RelayHostDto {
  id: string;
  host: string;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
  createdAt: string;
}
export interface TransportRouteDto extends Omit<RelayHostDto, 'host'> {
  destination: string;
  nexthop: string;
}
export interface TlsPolicyDto {
  id: string;
  destination: string;
  policy: TlsPolicyRow['policy'];
  parameters: string;
  enabled: boolean;
  createdAt: string;
}

const relayDto = (r: RelayHostRow): RelayHostDto => ({
  id: r.id,
  host: r.host,
  username: r.username,
  hasPassword: r.password !== '',
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});
const transportDto = (r: TransportRouteRow): TransportRouteDto => ({
  id: r.id,
  destination: r.destination,
  nexthop: r.nexthop,
  username: r.username,
  hasPassword: r.password !== '',
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});
const tlsDto = (r: TlsPolicyRow): TlsPolicyDto => ({
  id: r.id,
  destination: r.destination,
  policy: r.policy,
  parameters: r.parameters,
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Outgoing routing for the whole instance: smart hosts (chosen per domain or
 * mailbox), routes per destination and TLS policies per destination. Only
 * instance administrators manage them: they hold credentials of outside
 * services and apply to every organization. Postfix reads them through the
 * mail.* views.
 */
@Injectable()
export class RoutingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async relayHosts(): Promise<RelayHostDto[]> {
    return (await this.db.select().from(relayHosts).orderBy(desc(relayHosts.createdAt))).map(relayDto);
  }

  async createRelayHost(input: z.infer<typeof relayHostSchema>): Promise<RelayHostDto> {
    const [row] = await this.db.insert(relayHosts).values(input).returning();
    return relayDto(row!);
  }

  async updateRelayHost(id: string, input: z.infer<typeof relayHostUpdateSchema>): Promise<RelayHostDto> {
    const [row] = await this.db.update(relayHosts).set(input).where(eq(relayHosts.id, id)).returning();
    if (!row) throw new NotFoundException('Smart host not found');
    return relayDto(row);
  }

  async deleteRelayHost(id: string): Promise<void> {
    const deleted = await this.db.delete(relayHosts).where(eq(relayHosts.id, id)).returning({ id: relayHosts.id });
    if (deleted.length === 0) throw new NotFoundException('Smart host not found');
  }

  async transports(): Promise<TransportRouteDto[]> {
    return (await this.db.select().from(transportRoutes).orderBy(transportRoutes.destination)).map(transportDto);
  }

  async createTransport(input: z.infer<typeof transportSchema>): Promise<TransportRouteDto> {
    await this.assertNotHosted(input.destination);
    try {
      const [row] = await this.db.insert(transportRoutes).values(input).returning();
      return transportDto(row!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('There is already a route for this destination');
      throw error;
    }
  }

  async updateTransport(id: string, input: z.infer<typeof transportUpdateSchema>): Promise<TransportRouteDto> {
    const [row] = await this.db.update(transportRoutes).set(input).where(eq(transportRoutes.id, id)).returning();
    if (!row) throw new NotFoundException('Route not found');
    return transportDto(row);
  }

  async deleteTransport(id: string): Promise<void> {
    const deleted = await this.db
      .delete(transportRoutes)
      .where(eq(transportRoutes.id, id))
      .returning({ id: transportRoutes.id });
    if (deleted.length === 0) throw new NotFoundException('Route not found');
  }

  async tlsPolicies(): Promise<TlsPolicyDto[]> {
    return (await this.db.select().from(tlsPolicies).orderBy(tlsPolicies.destination)).map(tlsDto);
  }

  async createTlsPolicy(input: z.infer<typeof tlsPolicySchema>): Promise<TlsPolicyDto> {
    try {
      const [row] = await this.db.insert(tlsPolicies).values(input).returning();
      return tlsDto(row!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('There is already a policy for this destination');
      throw error;
    }
  }

  async updateTlsPolicy(id: string, input: z.infer<typeof tlsPolicyUpdateSchema>): Promise<TlsPolicyDto> {
    const [row] = await this.db.update(tlsPolicies).set(input).where(eq(tlsPolicies.id, id)).returning();
    if (!row) throw new NotFoundException('Policy not found');
    return tlsDto(row);
  }

  async deleteTlsPolicy(id: string): Promise<void> {
    const deleted = await this.db.delete(tlsPolicies).where(eq(tlsPolicies.id, id)).returning({ id: tlsPolicies.id });
    if (deleted.length === 0) throw new NotFoundException('Policy not found');
  }

  /** A route for a hosted domain would send its mail away from the mailboxes. */
  private async assertNotHosted(destination: string): Promise<void> {
    const name = destination.includes('@')
      ? destination.slice(destination.indexOf('@') + 1)
      : destination.replace(/^\./, '');
    const [hosted] = await this.db
      .select({ name: domains.name })
      .from(domains)
      .where(destination.startsWith('.') ? like(domains.name, `%.${name}`) : eq(domains.name, name))
      .limit(1);
    if (hosted) {
      throw new UnprocessableEntityException({
        message: `${hosted.name} is hosted here; its mail cannot be routed elsewhere`,
        code: 'DESTINATION_HOSTED',
      });
    }
  }

  record(session: AuthSession, req: Request, action: string, label: string): Promise<void> {
    return this.audit.recordInstance(
      {
        userId: session.user.id,
        userEmail: session.user.email,
        ipAddress: req.ip ?? null,
      },
      action,
      { type: 'routing', label },
    );
  }
}

@Controller('system')
@UseGuards(SuperAdminGuard)
export class RoutingController {
  constructor(@Inject(RoutingService) private readonly routing: RoutingService) {}

  @Get('relay-hosts')
  async relayHosts(): Promise<{ data: RelayHostDto[] }> {
    return { data: await this.routing.relayHosts() };
  }

  @Post('relay-hosts')
  async createRelayHost(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(relayHostSchema))
    body: z.infer<typeof relayHostSchema>,
  ): Promise<RelayHostDto> {
    const dto = await this.routing.createRelayHost(body);
    await this.routing.record(session, req, 'relay_host.created', dto.host);
    return dto;
  }

  @Patch('relay-hosts/:id')
  async updateRelayHost(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(relayHostUpdateSchema))
    body: z.infer<typeof relayHostUpdateSchema>,
  ): Promise<RelayHostDto> {
    const dto = await this.routing.updateRelayHost(id, body);
    await this.routing.record(session, req, 'relay_host.updated', dto.host);
    return dto;
  }

  @Delete('relay-hosts/:id')
  @HttpCode(204)
  async deleteRelayHost(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    await this.routing.deleteRelayHost(id);
    await this.routing.record(session, req, 'relay_host.deleted', id);
  }

  @Get('transports')
  async transports(): Promise<{ data: TransportRouteDto[] }> {
    return { data: await this.routing.transports() };
  }

  @Post('transports')
  async createTransport(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(transportSchema))
    body: z.infer<typeof transportSchema>,
  ): Promise<TransportRouteDto> {
    const dto = await this.routing.createTransport(body);
    await this.routing.record(session, req, 'transport.created', `${dto.destination} → ${dto.nexthop}`);
    return dto;
  }

  @Patch('transports/:id')
  async updateTransport(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(transportUpdateSchema))
    body: z.infer<typeof transportUpdateSchema>,
  ): Promise<TransportRouteDto> {
    const dto = await this.routing.updateTransport(id, body);
    await this.routing.record(session, req, 'transport.updated', `${dto.destination} → ${dto.nexthop}`);
    return dto;
  }

  @Delete('transports/:id')
  @HttpCode(204)
  async deleteTransport(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    await this.routing.deleteTransport(id);
    await this.routing.record(session, req, 'transport.deleted', id);
  }

  @Get('tls-policies')
  async tlsPolicies(): Promise<{ data: TlsPolicyDto[] }> {
    return { data: await this.routing.tlsPolicies() };
  }

  @Post('tls-policies')
  async createTlsPolicy(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(tlsPolicySchema))
    body: z.infer<typeof tlsPolicySchema>,
  ): Promise<TlsPolicyDto> {
    const dto = await this.routing.createTlsPolicy(body);
    await this.routing.record(session, req, 'tls_policy.created', `${dto.destination}: ${dto.policy}`);
    return dto;
  }

  @Patch('tls-policies/:id')
  async updateTlsPolicy(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(tlsPolicyUpdateSchema))
    body: z.infer<typeof tlsPolicyUpdateSchema>,
  ): Promise<TlsPolicyDto> {
    const dto = await this.routing.updateTlsPolicy(id, body);
    await this.routing.record(session, req, 'tls_policy.updated', `${dto.destination}: ${dto.policy}`);
    return dto;
  }

  @Delete('tls-policies/:id')
  @HttpCode(204)
  async deleteTlsPolicy(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    await this.routing.deleteTlsPolicy(id);
    await this.routing.record(session, req, 'tls_policy.deleted', id);
  }
}

@Module({
  controllers: [RoutingController],
  providers: [RoutingService],
})
export class RoutingModule {}
