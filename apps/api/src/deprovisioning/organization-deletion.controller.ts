import { Body, Controller, Delete, Inject, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { confirmDeletionSchema, type DeletionReport, OrganizationDeletionService } from './organization-deletion.service.js';

/** Instance administrators only: deleting a whole organization. */
@Controller('admin/organizations')
@UseGuards(SuperAdminGuard)
export class OrganizationDeletionController {
  constructor(@Inject(OrganizationDeletionService) private readonly deletion: OrganizationDeletionService) {}

  @Delete(':id')
  delete(
    @CurrentSession() session: AuthSession,
    @Param('id', new ZodValidationPipe(z.string().min(1).max(100))) id: string,
    @Body(new ZodValidationPipe(confirmDeletionSchema)) body: { confirm: string },
    @Req() req: Request,
  ): Promise<DeletionReport> {
    return this.deletion.delete(session, id, body.confirm, req.ip ?? null);
  }
}
