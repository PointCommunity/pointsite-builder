import type { AuditEventRecord, Role } from '../repositories/contracts';
import { ConflictError } from '../repositories/memory';
import { unboundFetch } from '../github/app-auth';

export interface AdminRoleRecord {
  githubLogin: string;
  githubUserId: number;
  role: Role;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface GitHubAccountResolver {
  resolve(login: string): Promise<{ id: number; login: string }>;
}

export class GitHubUserResolver implements GitHubAccountResolver {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = unboundFetch(fetcher);
  }

  async resolve(login: string) {
    const response = await this.fetcher(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'PointSite-Builder',
        },
      },
    );
    if (!response.ok) throw new Error('GITHUB_IDENTITY_NOT_FOUND');
    const value: { id?: unknown; login?: unknown } = await response.json();
    if (
      typeof value.id !== 'number' ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      typeof value.login !== 'string' ||
      !/^[A-Za-z0-9-]{1,39}$/.test(value.login)
    )
      throw new Error('GITHUB_IDENTITY_INVALID');
    return { id: value.id, login: value.login.toLowerCase() };
  }
}

export interface CapacityMetric {
  used: number;
  limit: number;
  percent: number;
  warning: boolean;
  unit: 'bytes' | 'operations';
}

export interface CapacityReport {
  privateMedia: CapacityMetric;
  revisionData: CapacityMetric;
  writesToday: CapacityMetric;
  measuredAt: string;
}

const metric = (used: number, limit: number, unit: CapacityMetric['unit']): CapacityMetric => ({
  used,
  limit,
  percent: Math.min(100, Math.round((used / limit) * 10_000) / 100),
  warning: used >= limit * 0.7,
  unit,
});

export class D1AdminService {
  constructor(
    private readonly database: D1Database,
    private readonly identities: GitHubAccountResolver = new GitHubUserResolver(),
  ) {}

  async listRoles(): Promise<AdminRoleRecord[]> {
    const rows = await this.database
      .prepare(
        'SELECT email, github_login, role, active, updated_at, updated_by FROM user_roles WHERE github_login IS NOT NULL ORDER BY github_login',
      )
      .all<{
        email: string;
        github_login: string;
        role: Role;
        active: number;
        updated_at: string;
        updated_by: string;
      }>();
    return rows.results.map((row) => ({
      githubLogin: row.github_login,
      githubUserId: Number(row.email.replace(/^github:/, '')),
      role: row.role,
      active: row.active === 1,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
  }

  async upsertRole(input: {
    githubLogin: string;
    role: Role;
    active: boolean;
    actor: string;
    requestId: string;
  }): Promise<AdminRoleRecord> {
    const requestedLogin = input.githubLogin.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,39}$/.test(requestedLogin)) throw new Error('VALIDATION_FAILED');
    const account = await this.identities.resolve(requestedLogin);
    const identity = `github:${account.id}`;
    if (!input.active || input.role !== 'administrator') {
      const remaining = await this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM user_roles WHERE role = 'administrator' AND active = 1 AND github_login IS NOT NULL AND email != ? COLLATE NOCASE",
        )
        .bind(identity)
        .first<{ count: number }>();
      const existing = await this.database
        .prepare('SELECT role, active FROM user_roles WHERE email = ? COLLATE NOCASE')
        .bind(identity)
        .first<{ role: Role; active: number }>();
      if (
        existing?.role === 'administrator' &&
        existing.active === 1 &&
        (remaining?.count ?? 0) === 0
      )
        throw new ConflictError('At least one active administrator is required');
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.database.batch([
      this.database
        .prepare(
          'INSERT INTO user_roles (email, role, active, created_at, updated_at, updated_by, github_login) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET role=excluded.role, active=excluded.active, updated_at=excluded.updated_at, updated_by=excluded.updated_by, github_login=excluded.github_login',
        )
        .bind(identity, input.role, input.active ? 1 : 0, now, now, input.actor, account.login),
      this.database
        .prepare(
          "INSERT INTO audit_events (id, occurred_at, actor, action, target_type, target_id, outcome, request_id, metadata_json) VALUES (?, ?, ?, 'role.upsert', 'role', ?, 'succeeded', ?, ?)",
        )
        .bind(
          id,
          now,
          input.actor,
          identity,
          input.requestId,
          JSON.stringify({ role: input.role, active: input.active }),
        ),
    ]);
    return {
      githubLogin: account.login,
      githubUserId: account.id,
      role: input.role,
      active: input.active,
      updatedAt: now,
      updatedBy: input.actor,
    };
  }

  async listAudit(limit = 100): Promise<AuditEventRecord[]> {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const rows = await this.database
      .prepare(
        `SELECT audit_events.id, audit_events.occurred_at,
          COALESCE('@' || actor_role.github_login, audit_events.actor) AS actor,
          audit_events.action, audit_events.target_type,
          COALESCE('@' || target_role.github_login, audit_events.target_id) AS target_id,
          audit_events.outcome, audit_events.request_id, audit_events.metadata_json
        FROM audit_events
        LEFT JOIN user_roles AS actor_role ON actor_role.email = audit_events.actor COLLATE NOCASE
        LEFT JOIN user_roles AS target_role ON target_role.email = audit_events.target_id COLLATE NOCASE
        ORDER BY audit_events.occurred_at DESC, audit_events.id DESC LIMIT ?`,
      )
      .bind(safeLimit)
      .all<{
        id: string;
        occurred_at: string;
        actor: string;
        action: string;
        target_type: string;
        target_id: string;
        outcome: AuditEventRecord['outcome'];
        request_id: string;
        metadata_json: string;
      }>();
    return rows.results.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      outcome: row.outcome,
      requestId: row.request_id,
      metadata: JSON.parse(row.metadata_json) as AuditEventRecord['metadata'],
    }));
  }

  async capacity(): Promise<CapacityReport> {
    const [media, revisions, writes] = await Promise.all([
      this.database
        .prepare('SELECT COALESCE(SUM(byte_size), 0) AS used FROM media_assets')
        .first<{ used: number }>(),
      this.database
        .prepare('SELECT COALESCE(SUM(length(document_json)), 0) AS used FROM revisions')
        .first<{ used: number }>(),
      this.database
        .prepare(
          "SELECT COUNT(*) AS used FROM audit_events WHERE occurred_at >= datetime('now', 'start of day')",
        )
        .first<{ used: number }>(),
    ]);
    return {
      privateMedia: metric(media?.used ?? 0, 250 * 1024 * 1024, 'bytes'),
      revisionData: metric(revisions?.used ?? 0, 500 * 1024 * 1024, 'bytes'),
      writesToday: metric(writes?.used ?? 0, 100_000, 'operations'),
      measuredAt: new Date().toISOString(),
    };
  }
}
