import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { computeDiscoveryUrl, DiscoveryError, discoverOIDCConfig } from '@better-auth/sso';
import { AuditService } from '../audit/audit.service.js';
import { AUTH_BASE_PATH } from '../auth/auth.js';
import type { Env } from '../config/env.js';
import { ENV } from '../core/tokens.js';
import { DomainsRepository } from '../domains/domains.repository.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { IssuerPolicy } from './issuer-policy.js';
import type { CreateSsoProviderInput, SsoProviderDto } from './sso.dto.js';
import { SsoRepository, type SsoProviderRow } from './sso.repository.js';

/**
 * Single sign-on through an organization's OpenID Connect identity provider.
 * Each provider covers one verified domain of the organization; who it may
 * sign in is decided by resolveSsoUser (an active mailbox of the organization).
 */
@Injectable()
export class SsoService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SsoRepository) private readonly providers: SsoRepository,
    @Inject(DomainsRepository) private readonly domains: DomainsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext): Promise<SsoProviderDto[]> {
    return (await this.providers.list(ctx)).map((row) => this.toDto(row));
  }

  async create(ctx: TenantContext, input: CreateSsoProviderInput): Promise<SsoProviderDto> {
    const domain = await this.domains.findById(ctx, input.domainId);
    if (!domain) throw new NotFoundException('Domain not found');
    if (domain.status !== 'active') {
      throw new UnprocessableEntityException('Verify the domain before setting up single sign-on for it');
    }
    if (await this.providers.existsForDomain(domain.name)) {
      throw new ConflictException('This domain already has a sign-in provider');
    }

    // Better Auth checks every URL it fetches at sign-in (also after DNS
    // resolution); the discovery document is fetched now, so its host is
    // checked here first. See IssuerPolicy.
    const policy = new IssuerPolicy(this.env.TRUSTED_ORIGINS);
    const discoveryUrl = computeDiscoveryUrl(input.issuer);
    if (!(await policy.allowsFetch(discoveryUrl))) {
      throw new UnprocessableEntityException({
        message: 'The issuer must be a public https address. An identity provider on a private network must be listed in TRUSTED_ORIGINS by the instance administrator.',
        code: 'SSO_ISSUER_NOT_ALLOWED',
      });
    }
    let discovered: Awaited<ReturnType<typeof discoverOIDCConfig>>;
    try {
      discovered = await discoverOIDCConfig({
        issuer: input.issuer,
        discoveryEndpoint: discoveryUrl,
        isTrustedOrigin: (url) => policy.allowsUrl(url),
      });
    } catch (error) {
      if (error instanceof DiscoveryError) {
        throw new UnprocessableEntityException({ message: error.message, code: 'SSO_DISCOVERY_FAILED' });
      }
      throw error;
    }

    const providerId = `px-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    // The shape Better Auth's SSO plugin reads back at sign-in.
    const oidcConfig = JSON.stringify({
      issuer: discovered.issuer,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      discoveryEndpoint: discovered.discoveryEndpoint,
      authorizationEndpoint: discovered.authorizationEndpoint,
      tokenEndpoint: discovered.tokenEndpoint,
      tokenEndpointAuthentication: discovered.tokenEndpointAuthentication,
      jwksEndpoint: discovered.jwksEndpoint,
      userInfoEndpoint: discovered.userInfoEndpoint,
      pkce: true,
      scopes: ['openid', 'email', 'profile'],
      overrideUserInfo: false,
    });
    const row = await this.providers.create(ctx, {
      providerId,
      issuer: discovered.issuer,
      domain: domain.name,
      oidcConfig,
    });
    await this.audit.record(ctx, 'sign_in_provider.added', { type: 'sign_in_provider', id: row.id, label: domain.name }, { issuer: row.issuer });
    return this.toDto(row);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const row = await this.providers.findById(ctx, id);
    if (!row || !(await this.providers.delete(ctx, id))) throw new NotFoundException('Sign-in provider not found');
    await this.audit.record(ctx, 'sign_in_provider.removed', { type: 'sign_in_provider', id: row.id, label: row.domain });
  }

  /** Used when the organization is deleted. */
  removeAll(ctx: TenantContext): Promise<number> {
    return this.providers.deleteAll(ctx);
  }

  private toDto(row: SsoProviderRow): SsoProviderDto {
    const config = JSON.parse(row.oidcConfig ?? '{}') as { clientId?: string };
    return {
      id: row.id,
      providerId: row.providerId,
      domain: row.domain,
      issuer: row.issuer,
      clientId: config.clientId ?? '',
      callbackUrl: `${this.env.AUTH_URL.replace(/\/+$/, '')}${AUTH_BASE_PATH}/sso/callback/${row.providerId}`,
    };
  }
}
