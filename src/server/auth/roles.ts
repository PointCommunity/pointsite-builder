import type { Role } from '../repositories/contracts';

export interface Actor {
  email: string;
  displayName?: string;
  role: Role;
  repositoryPermission?: 'admin' | 'maintain' | 'write' | 'triage' | 'read';
}

export interface RoleRecord {
  role: Role;
  active: boolean;
}

export interface RoleDirectory {
  getRole(email: string): Promise<RoleRecord | null>;
}

const authority: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  publisher: 2,
  administrator: 3,
};

export class AuthorizationError extends Error {
  constructor(message = 'You do not have permission to perform this action') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export function requireRole(actor: Actor, minimumRole: Role): Actor {
  if (authority[actor.role] < authority[minimumRole]) throw new AuthorizationError();
  return actor;
}

export function requirePublishAccess(actor: Actor): Actor {
  requireRole(actor, 'publisher');
  if (
    !actor.repositoryPermission ||
    !['write', 'maintain', 'admin'].includes(actor.repositoryPermission)
  ) {
    throw new AuthorizationError('Current GitHub write access to PointSite staging is required');
  }
  return actor;
}
