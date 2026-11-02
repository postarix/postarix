import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isUniqueViolation } from '../common/pg-errors.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { type CreateDomainInput, type DomainDto, toDomainDto } from './domains.dto.js';
import { DomainsRepository } from './domains.repository.js';

@Injectable()
export class DomainsService {
  constructor(@Inject(DomainsRepository) private readonly repository: DomainsRepository) {}

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

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const deleted = await this.repository.delete(ctx, id);
    if (!deleted) throw new NotFoundException('Domain not found');
  }
}
