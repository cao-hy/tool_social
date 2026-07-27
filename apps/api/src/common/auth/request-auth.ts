import { AppError } from '../errors/app-error';
import type { AuthenticatedRequest, AuthenticatedUser } from './auth.types';

export function requireUser(request: AuthenticatedRequest): AuthenticatedUser {
  if (!request.user) throw AppError.unauthenticated();
  return request.user;
}

export function requireMembership(request: AuthenticatedRequest) {
  if (!request.membership) throw AppError.forbidden();
  return request.membership;
}
