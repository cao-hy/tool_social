import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasAllPermissions, type Permission } from '@socialhub/shared';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { REQUIRED_PERMISSIONS } from '../decorators/require-permissions.decorator';
import { AppError } from '../errors/app-error';

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = request.membership?.role;
    if (!role || !hasAllPermissions(role, required)) {
      throw AppError.forbidden();
    }

    return true;
  }
}
