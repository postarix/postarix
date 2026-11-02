import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AddressRegistry } from '../common/address-registry.js';
import { isUniqueViolation } from '../common/pg-errors.js';
import type { AliasRow } from '../db/schema/index.js';
import { DomainsRepository } from '../domains/domains.repository.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import {
  type AliasDto,
  type CreateAliasInput,
  toAliasDto,
  type UpdateAliasInput,
} from './aliases.dto.js';
import { AliasesRepository } from './aliases.repository.js';

@Injectable()
export class AliasesService {
  constructor(
    @Inject(AliasesRepository) private readonly repository: AliasesRepository,
    @Inject(DomainsRepository) private readonly domains: DomainsRepository,
    @Inject(AddressRegistry) private readonly addresses: AddressRegistry,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext): Promise<AliasDto[]> {
    return (await this.repository.list(ctx)).map(toAliasDto);
  }

  async get(ctx: TenantContext, id: string): Promise<AliasDto> {
    return toAliasDto(await this.require(ctx, id));
  }

  async create(ctx: TenantContext, input: CreateAliasInput): Promise<AliasDto> {
    const domain = await this.domains.findById(ctx, input.domainId);
    if (!domain) {
      throw new UnprocessableEntityException({ message: 'Unknown domain', code: 'UNKNOWN_DOMAIN' });
    }
    if (domain.status !== 'active') {
      throw new UnprocessableEntityException({
        message: 'Verify the domain before adding aliases',
        code: 'DOMAIN_NOT_VERIFIED',
      });
    }

    const address = `${input.localPart}@${domain.name}`;
    assertNoSelfReference(address, input.destinations);
    if (await this.addresses.isTaken(address)) {
      throw new ConflictException('This address is already in use');
    }

    try {
      const row = await this.repository.create(ctx, {
        domainId: domain.id,
        localPart: input.localPart,
        address,
        destinations: input.destinations,
        enabled: input.enabled,
      });
      await this.audit.record(
        ctx,
        'alias.created',
        { type: 'alias', id: row.id, label: address },
        { destinations: input.destinations },
      );
      return toAliasDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('This address is already in use');
      throw error;
    }
  }

  async update(ctx: TenantContext, id: string, input: UpdateAliasInput): Promise<AliasDto> {
    const current = await this.require(ctx, id);
    if (input.destinations) assertNoSelfReference(current.address, input.destinations);

    const changes: Partial<Pick<AliasRow, 'destinations' | 'enabled'>> = {};
    if (input.destinations !== undefined) changes.destinations = input.destinations;
    if (input.enabled !== undefined) changes.enabled = input.enabled;

    const row = await this.repository.update(ctx, id, changes);
    if (!row) throw new NotFoundException('Alias not found');
    await this.audit.record(ctx, 'alias.updated', { type: 'alias', id: row.id, label: row.address }, changes);
    return toAliasDto(row);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const alias = await this.require(ctx, id);
    if (!(await this.repository.delete(ctx, id))) throw new NotFoundException('Alias not found');
    await this.audit.record(ctx, 'alias.deleted', { type: 'alias', id: alias.id, label: alias.address });
  }

  private async require(ctx: TenantContext, id: string): Promise<AliasRow> {
    const row = await this.repository.findById(ctx, id);
    if (!row) throw new NotFoundException('Alias not found');
    return row;
  }
}

function assertNoSelfReference(address: string, destinations: string[]): void {
  if (destinations.includes(address)) {
    throw new BadRequestException('An alias cannot forward to itself');
  }
}
