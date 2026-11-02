import { Module } from '@nestjs/common';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import {
  AdminOrganizationsController,
  MyOrganizationsController,
  OrganizationController,
} from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  controllers: [MyOrganizationsController, AdminOrganizationsController, OrganizationController],
  providers: [OrganizationsService, OrgAccessGuard, SuperAdminGuard],
})
export class OrganizationsModule {}
