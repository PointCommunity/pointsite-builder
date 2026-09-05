import { authenticateRequest } from '../src/server/auth/access';
import type { RoleDirectory, RoleRecord } from '../src/server/auth/roles';
import { parseConfig } from '../src/server/config';
import { createApp } from '../src/server/index';
import { D1DraftRepository } from '../src/server/repositories/d1';

class D1RoleDirectory implements RoleDirectory {
  constructor(private readonly database: D1Database) {}

  async getRole(email: string): Promise<RoleRecord | null> {
    const row = await this.database
      .prepare('SELECT role, active FROM user_roles WHERE email = ?')
      .bind(email)
      .first<{ role: RoleRecord['role']; active: number }>();
    return row ? { role: row.role, active: row.active === 1 } : null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = parseConfig(env as unknown as Record<string, unknown>);
    const roles = new D1RoleDirectory(env.DB);
    const app = createApp({
      repository: new D1DraftRepository(env.DB),
      authenticate: (incomingRequest) => authenticateRequest(incomingRequest, config, roles),
      environment: config.environment,
      version: config.appVersion,
    });
    return app.fetch(request);
  },
};
