import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Env } from '../config/env.js';
import { type DnsResolver, isNoRecordError } from '../core/dns.js';
import { DNS_RESOLVER, ENV } from '../core/tokens.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/pg-errors.js';
import { AuditService } from '../audit/audit.service.js';
import { DkimService } from '../dkim/dkim.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { type CreateDomainInput, type DnsRecordDto, type DomainDto, toDomainDto } from './domains.dto.js';
import { DomainsRepository } from './domains.repository.js';
import { mtaStsPolicy, mtaStsPolicyId } from '../discovery/discovery.js';
import { checkDnsRecords, type DnsRecordCheckDto } from './dns-check.js';

const DNS_CHECK_CACHE_MS = 30_000;

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);
  private readonly dnsCheckCache = new Map<string, { result: DnsRecordCheckDto[]; expires: number }>();

  constructor(
    @Inject(DomainsRepository) private readonly repository: DomainsRepository,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(ENV) private readonly env: Env,
    @Inject(DkimService) private readonly dkim: DkimService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext): Promise<DomainDto[]> {
    const rows = await this.repository.list(ctx);
    return rows.map(toDomainDto);
  }

  async get(ctx: TenantContext, id: string): Promise<DomainDto> {
    const row = await this.repository.findById(ctx, id);
    if (!row) throw new NotFoundException('Domain not found');
    return toDomainDto(row);
  }

  async create(ctx: TenantContext, input: CreateDomainInput): Promise<DomainDto> {
    let row;
    try {
      row = await this.repository.create(ctx, input.name);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Only reachable for a duplicate inside the caller's own organization.
        throw new ConflictException('Domain already exists in this organization');
      }
      throw error;
    }
    try {
      await this.dkim.createForDomain(row.id);
    } catch (error) {
      await this.repository.delete(ctx, row.id);
      throw error;
    }
    await this.audit.record(ctx, 'domain.created', { type: 'domain', id: row.id, label: row.name });
    return toDomainDto(row);
  }

  /** The DNS records the organization must publish for this domain. */
  /**
   * The records the domain should publish, with what DNS answers for each
   * today. Results are kept for a short while per domain, so repeated clicks
   * cannot turn the API into a DNS query pump.
   */
  async dnsCheck(ctx: TenantContext, id: string): Promise<DnsRecordCheckDto[]> {
    const expected = await this.dnsRecords(ctx, id); // also enforces tenancy
    const key = `${id}:${JSON.stringify(expected)}`;
    const cached = this.dnsCheckCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const result = await checkDnsRecords(this.dns, expected, this.env.MAIL_HOSTNAME);
    if (this.dnsCheckCache.size > 10_000) this.dnsCheckCache.clear();
    this.dnsCheckCache.set(key, { result, expires: Date.now() + DNS_CHECK_CACHE_MS });
    return result;
  }

  async dnsRecords(ctx: TenantContext, id: string): Promise<DnsRecordDto[]> {
    const domain = await this.repository.findById(ctx, id);
    if (!domain) throw new NotFoundException('Domain not found');
    const host = this.env.MAIL_HOSTNAME;
    const records: DnsRecordDto[] = [];
    if (domain.status === 'pending') {
      records.push({
        purpose: 'verification',
        type: 'TXT',
        name: domain.name,
        value: `postarix-verification=${domain.verificationToken}`,
      });
    }
    records.push(
      { purpose: 'mx', type: 'MX', name: domain.name, value: `10 ${host}.` },
      { purpose: 'spf', type: 'TXT', name: domain.name, value: 'v=spf1 mx -all' },
    );
    const key = await this.dkim.activeKey(domain.id);
    if (key) {
      records.push({
        purpose: 'dkim',
        type: 'TXT',
        name: `${key.selector}._domainkey.${domain.name}`,
        value: `v=DKIM1; k=rsa; p=${key.publicKey}`,
      });
    }
    records.push({
      purpose: 'dmarc',
      type: 'TXT',
      name: `_dmarc.${domain.name}`,
      value: 'v=DMARC1; p=quarantine; adkim=s; aspf=s',
    });
    // Mail apps configure themselves (Thunderbird autoconfig), and other
    // servers learn to require TLS (MTA-STS: the policy is served on mta-sts.<domain>).
    const policyId = mtaStsPolicyId(mtaStsPolicy(this.env.MTA_STS_MODE, host));
    records.push(
      { purpose: 'autoconfig', type: 'CNAME', name: `autoconfig.${domain.name}`, value: `${host}.` },
      { purpose: 'mta-sts', type: 'CNAME', name: `mta-sts.${domain.name}`, value: `${host}.` },
      { purpose: 'mta-sts-id', type: 'TXT', name: `_mta-sts.${domain.name}`, value: `v=STSv1; id=${policyId}` },
    );
    return records;
  }

  /**
   * Proves ownership by looking for the domain's verification value in its TXT
   * records, then activates it. Activation is idempotent.
   */
  async verify(ctx: TenantContext, id: string): Promise<DomainDto> {
    const domain = await this.repository.findById(ctx, id);
    if (!domain) throw new NotFoundException('Domain not found');
    if (domain.status === 'active') {
      // Verifying again re-publishes the signing key, in case that failed before.
      await this.dkim.publish(domain);
      return toDomainDto(domain);
    }
    if (domain.status !== 'pending') return toDomainDto(domain);

    if (this.env.DOMAIN_VERIFICATION === 'dns') {
      const expected = `postarix-verification=${domain.verificationToken}`;
      const records = await this.lookupTxt(domain.name);
      if (!records.includes(expected)) {
        throw new UnprocessableEntityException({
          message: `TXT record not found. Publish "${expected}" on ${domain.name} and try again.`,
          code: 'VERIFICATION_RECORD_MISSING',
        });
      }
    }

    try {
      const row = await this.repository.activate(ctx, id);
      if (!row) throw new NotFoundException('Domain not found');
      try {
        await this.dkim.publish(row);
      } catch (error) {
        // The domain is verified either way; the periodic sync publishes the key.
        this.logger.error(`Cannot publish the DKIM key of ${row.name}: ${(error as Error).message}`);
      }
      await this.audit.record(ctx, 'domain.verified', { type: 'domain', id: row.id, label: row.name });
      return toDomainDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This domain is already active in another organization');
      }
      throw error;
    }
  }

  private async lookupTxt(name: string): Promise<string[]> {
    try {
      const records = await this.dns.resolveTxt(name);
      // A TXT record may be split into several strings; they form one value.
      return records.map((chunks) => chunks.join(''));
    } catch (error) {
      if (isNoRecordError(error)) return [];
      throw new ServiceUnavailableException('DNS lookup failed; try again later');
    }
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const domain = await this.repository.findById(ctx, id);
    if (!domain) throw new NotFoundException('Domain not found');
    let deleted: boolean;
    try {
      deleted = await this.repository.delete(ctx, id);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException('Delete the domain\'s mailboxes and aliases first');
      }
      throw error;
    }
    if (!deleted) throw new NotFoundException('Domain not found');
    if (domain.status !== 'pending') await this.dkim.unpublish(domain.name);
    await this.audit.record(ctx, 'domain.deleted', { type: 'domain', id: domain.id, label: domain.name });
  }
}
