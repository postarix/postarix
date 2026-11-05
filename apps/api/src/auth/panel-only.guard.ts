import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { type AuthenticatedRequest, isPersonSession } from './session.js';

/** Routes for people in the admin panel only: API keys and application tokens are refused. */
@Injectable()
export class PanelOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest & { appToken?: unknown }>();
    if (request.appToken || !isPersonSession(request.auth)) {
      throw new ForbiddenException({ message: 'Only available in the admin panel', code: 'PANEL_ONLY' });
    }
    return true;
  }
}
