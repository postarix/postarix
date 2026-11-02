import { type CanActivate, type ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { type AuthenticatedRequest, isSuperAdmin } from './session.js';

/** Instance super-admins only. Everyone else gets 404, as if the route did not exist. */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth || !isSuperAdmin(request.auth)) throw new NotFoundException();
    return true;
  }
}
