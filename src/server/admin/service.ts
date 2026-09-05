import type { AuditEventRecord, Role } from '../repositories/contracts';
import { ConflictError } from '../repositories/memory';

export interface AdminRoleRecord {
  email: string;
  role: Role;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
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
  constructor(private readonly database: D1Database) {}

  async listRoles(): Promise<AdminRoleRecord[]> {
    const rows = await this.database
      .prepare('SELECT email, role, active, updated_at, updated_by FROM user_roles ORDER BY email')
      .all<{ email: string; role: Role; active: number; updated_at: string; updated_by: string }>();
    return rows.results.map((row) => ({
      email: row.email,
      role: row.role,
      active: row.active === 1,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
  }

  async upsertRole(input: {
    email: string;
    role: Role;
    active: boolean;
    actor: string;
    requestId: string;
  }): Promise<AdminRoleRecord> {
    const email = input.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('VALIDATION_FAILED');
    if (!input.active || input.role !== 'administrator') {
      const remaining = await this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM user_roles WHERE role = 'administrator' AND active = 1 AND email != ? COLLATE NOCASE",
        )
        .bind(email)
        .first<{ count: number }>();
      const existing = await this.database
        .prepare('SELECT role, active FROM user_roles WHERE email = ? COLLATE NOCASE')
        .bind(email)
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
          'INSERT INTO user_roles (email, role, active, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET role=excluded.role, active=excluded.active, updated_at=excluded.updated_at, updated_by=excluded.updated_by',
        )
        .bind(email, input.role, input.active ? 1 : 0, now, now, input.actor),
      this.database
        .prepare(
          "INSERT INTO audit_events (id, occurred_at, actor, action, target_type, target_id, outcome, request_id, metadata_json) VALUES (?, ?, ?, 'role.upsert', 'role', ?, 'succeeded', ?, ?)",
        )
        .bind(
          id,
          now,
          input.actor,
          email,
          input.requestId,
          JSON.stringify({ role: input.role, active: input.active }),
        ),
    ]);
    return {
      email,
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
        'SELECT id, occurred_at, actor, action, target_type, target_id, outcome, request_id, metadata_json FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT ?',
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
