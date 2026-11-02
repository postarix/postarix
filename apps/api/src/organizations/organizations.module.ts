import { Module } from '@nestjs/common';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import {
  AdminOrganizationsController,
  MyOrganizationsController,
  OrganizationController,
} from './organizations.controller.js';
import { MySecondFactorController, OrganizationSecurityController, OrganizationSecurityService } from './organization-security.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  controllers: [MyOrganizationsController, AdminOrganizationsController, OrganizationController, OrganizationSecurityController, MySecondFactorController],
  providers: [OrganizationsService, OrganizationSecurityService, OrgAccessGuard, SuperAdminGuard],
})
export class OrganizationsModule {}
