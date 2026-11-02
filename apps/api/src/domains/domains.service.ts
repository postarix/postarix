import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Env } from '../config/env.js';
import type { DnsResolver } from '../core/dns.js';
import { DNS_RESOLVER, ENV } from '../core/tokens.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/pg-errors.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { type CreateDomainInput, type DomainDto, toDomainDto } from './domains.dto.js';
import { DomainsRepository } from './domains.repository.js';

@Injectable()
export class DomainsService {
  constructor(
    @Inject(DomainsRepository) private readonly repository: DomainsRepository,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(ENV) private readonly env: Env,
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
    try {
      const row = await this.repository.create(ctx, input.name);
      return toDomainDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Only reachable for a duplicate inside the caller's own organization.
        throw new ConflictException('Domain already exists in this organization');
      }
      throw error;
    }
  }

  /**
   * Proves ownership by looking for the domain's verification value in its TXT
   * records, then activates it. Activation is idempotent.
   */
  async verify(ctx: TenantContext, id: string): Promise<DomainDto> {
    const domain = await this.repository.findById(ctx, id);
    if (!domain) throw new NotFoundException('Domain not found');
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
      const code = (error as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return [];
      throw new ServiceUnavailableException('DNS lookup failed; try again later');
    }
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
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
  }
}
