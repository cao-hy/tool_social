import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@socialhub/shared';

export const REQUIRED_PERMISSIONS = Symbol('REQUIRED_PERMISSIONS');

export function RequirePermissions(...permissions: Permission[]) {
  return SetMetadata(REQUIRED_PERMISSIONS, permissions);
}
