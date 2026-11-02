import { sealNewOidcConfig, sealOidcConfig } from './sso-crypto.js';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
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
import { X509Certificate } from 'node:crypto';
import type { CreateOidcProviderInput, CreateSamlProviderInput, CreateSsoProviderInput, SsoProviderDto } from './sso.dto.js';
import { SsoRepository, type SsoProviderRow } from './sso.repository.js';

const SAML_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

/** A PEM certificate from what an identity provider shows (PEM, or its base64 body). */
export function readCertificate(text: string): X509Certificate {
  const body = text.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) throw new UnprocessableEntityException('The certificate is not valid');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  try {
    return new X509Certificate(pem);
  } catch {
    throw new UnprocessableEntityException('The certificate is not valid');
  }
}

/**
 * Single sign-on through an organization's identity provider, over OpenID
 * Connect or SAML 2.0.
 * Each provider covers one verified domain of the organization; who it may
 * sign in is decided by resolveSsoUser (an active mailbox of the organization).
 */
@Injectable()
export class SsoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SsoRepository) private readonly providers: SsoRepository,
    @Inject(DomainsRepository) private readonly domains: DomainsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Encrypts client secrets of providers saved before they were encrypted. */
  async onApplicationBootstrap(): Promise<void> {
    const changed = await this.providers.resealAll((stored) => sealOidcConfig(stored, this.env.AUTH_SECRET));
    if (changed > 0) this.logger.log(`Encrypted the client secret of ${changed} sign-in provider(s)`);
  }

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
    return input.type === 'saml' ? this.createSaml(ctx, domain.name, input) : this.createOidc(ctx, domain.name, input);
  }

  /**
   * SAML 2.0: Postarix sends people to the identity provider's sign-in URL
   * and accepts only signed assertions for itself (its entity ID as the
   * audience), answering a request it made (no unsolicited responses), within
   * their validity period. Nothing is fetched from the identity provider.
   */
  private async createSaml(ctx: TenantContext, domainName: string, input: CreateSamlProviderInput): Promise<SsoProviderDto> {
    const certificate = readCertificate(input.certificate);
    if (new Date(certificate.validTo) < new Date()) throw new UnprocessableEntityException('The certificate has expired');
    if (this.env.NODE_ENV === 'production' && new URL(input.ssoUrl).protocol !== 'https:') {
      throw new UnprocessableEntityException('The sign-in URL must use https');
    }
    const providerId = `px-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const urls = this.samlUrls(providerId);
    const samlConfig = JSON.stringify({
      issuer: urls.entityId,
      audience: urls.entityId,
      entryPoint: input.ssoUrl,
      cert: certificate.toString(),
      callbackUrl: this.env.AUTH_URL,
      idpMetadata: {
        entityID: input.entityId,
        cert: certificate.toString(),
        singleSignOnService: [{ Binding: SAML_REDIRECT, Location: input.ssoUrl }],
      },
      spMetadata: { entityID: urls.entityId },
      wantAssertionsSigned: true,
      identifierFormat: NAMEID_EMAIL,
    });
    const row = await this.providers.create(ctx, { providerId, issuer: input.entityId, domain: domainName, samlConfig });
    await this.audit.record(ctx, 'sign_in_provider.added', { type: 'sign_in_provider', id: row.id, label: domainName }, { issuer: row.issuer, type: 'saml' });
    return this.toDto(row);
  }

  private async createOidc(ctx: TenantContext, domainName: string, input: CreateOidcProviderInput): Promise<SsoProviderDto> {

    // Better Auth checks every URL it fetches at sign-in (also after DNS
    // resolution); the discovery document is fetched now, so its host is
    // checked here first. See IssuerPolicy.
    const policy = new IssuerPolicy(this.env.SSO_TRUSTED_ISSUERS);
    const discoveryUrl = computeDiscoveryUrl(input.issuer);
    if (!(await policy.allowsFetch(discoveryUrl))) {
      throw new UnprocessableEntityException({
        message: 'The issuer must be a public https address. An identity provider on a private network must be listed in SSO_TRUSTED_ISSUERS by the instance administrator.',
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
      domain: domainName,
      // The client secret is stored encrypted; Better Auth reads it through
      // the adapter in auth.ts, which opens it.
      oidcConfig: sealNewOidcConfig(oidcConfig, this.env.AUTH_SECRET),
    });
    await this.audit.record(ctx, 'sign_in_provider.added', { type: 'sign_in_provider', id: row.id, label: domainName }, { issuer: row.issuer, type: 'oidc' });
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

  private samlUrls(providerId: string) {
    const base = `${this.env.AUTH_URL.replace(/\/+$/, '')}${AUTH_BASE_PATH}`;
    return {
      entityId: `${base}/sso/saml2/sp/metadata?providerId=${providerId}`,
      acsUrl: `${base}/sso/saml2/sp/acs/${providerId}`,
    };
  }

  private toDto(row: SsoProviderRow): SsoProviderDto {
    if (row.samlConfig) {
      const config = JSON.parse(row.samlConfig) as { cert?: string };
      const urls = this.samlUrls(row.providerId);
      let expires: string | null;
      try {
        expires = config.cert ? new Date(new X509Certificate(config.cert).validTo).toISOString() : null;
      } catch {
        expires = null;
      }
      return {
        id: row.id,
        type: 'saml',
        providerId: row.providerId,
        domain: row.domain,
        issuer: row.issuer,
        clientId: '',
        callbackUrl: urls.acsUrl,
        entityId: urls.entityId,
        certificateExpiresAt: expires,
      };
    }
    const config = JSON.parse(row.oidcConfig ?? '{}') as { clientId?: string };
    return {
      id: row.id,
      type: 'oidc',
      providerId: row.providerId,
      domain: row.domain,
      issuer: row.issuer,
      clientId: config.clientId ?? '',
      callbackUrl: `${this.env.AUTH_URL.replace(/\/+$/, '')}${AUTH_BASE_PATH}/sso/callback/${row.providerId}`,
      entityId: null,
      certificateExpiresAt: null,
    };
  }
}
