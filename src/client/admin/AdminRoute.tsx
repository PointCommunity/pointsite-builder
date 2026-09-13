import { useEffect, useState } from 'react';
import type { Role } from '../../server/repositories/contracts';
import { api, type AdminRoleItem, type AuditItem, type CapacityReport } from '../api';
import {
  auditActionLabel,
  auditDetails,
  auditOutcomeLabel,
  auditTargetLabel,
} from './audit-language';

const roles: Role[] = ['viewer', 'editor', 'publisher', 'administrator'];
const bytes = (value: number | null) =>
  value === null ? 'Unknown' : `${(value / 1024 / 1024).toFixed(1)} MiB`;

function Capacity({ report }: { report: CapacityReport }) {
  const items = [
    ['Allocated database storage', report.storage.allocatedBytes],
    ['Private media payload', report.storage.privateMediaBytes],
    ['Revision payload', report.storage.revisionPayloadBytes],
    ['Request receipt payload', report.storage.receiptPayloadBytes],
  ] as const;
  return (
    <section className="admin-card" aria-labelledby="capacity-title">
      <h3 id="capacity-title">Capacity</h3>
      <div className="capacity-grid">
        {items.map(([label, item]) => (
          <div className="capacity-meter" key={label}>
            <div>
              <strong>{label}</strong>
              <span>{bytes(item)}</span>
            </div>
          </div>
        ))}
      </div>
      <p>
        {report.activity.auditEvents.toLocaleString()} audit events since{' '}
        {new Date(report.activity.periodStart).toUTCString()}.
      </p>
      <p>Provider usage: unknown. {report.providerUsage.reason}</p>
      <small>
        Measured {new Date(report.measuredAt).toLocaleString()}. Payload sizes exclude indexes and
        other database records.
      </small>
    </section>
  );
}

export function AdminRoute() {
  const [roleItems, setRoleItems] = useState<AdminRoleItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [capacity, setCapacity] = useState<CapacityReport | null>(null);
  const [githubLogin, setGithubLogin] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [status, setStatus] = useState('Loading administration…');
  const load = async () => {
    const [nextRoles, nextAudit, nextCapacity] = await Promise.all([
      api.listRoles(),
      api.listAudit(),
      api.getCapacity(),
    ]);
    setRoleItems(nextRoles);
    setAudit(nextAudit);
    setCapacity(nextCapacity);
    setStatus('Administration loaded');
  };
  useEffect(() => {
    let active = true;
    void Promise.all([api.listRoles(), api.listAudit(), api.getCapacity()])
      .then(([nextRoles, nextAudit, nextCapacity]) => {
        if (!active) return;
        setRoleItems(nextRoles);
        setAudit(nextAudit);
        setCapacity(nextCapacity);
        setStatus('Administration loaded');
      })
      .catch(() => {
        if (active) setStatus('Administration could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async (input: { githubLogin: string; role: Role; active: boolean }) => {
    setStatus(`Saving @${input.githubLogin}…`);
    try {
      await api.upsertRole(input);
      await load();
      setGithubLogin('');
      setStatus(`@${input.githubLogin} updated`);
    } catch {
      setStatus(`@${input.githubLogin} could not be updated`);
    }
  };
  return (
    <div className="admin-route">
      <header className="section-heading">
        <div>
          <p className="eyebrow">Administrator only</p>
          <h2>Operations</h2>
        </div>
        <p role="status" aria-live="polite">
          {status}
        </p>
      </header>
      {capacity ? <Capacity report={capacity} /> : null}
      <section className="admin-card" aria-labelledby="roles-title">
        <h3 id="roles-title">Access roles</h3>
        <form
          className="inline-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ githubLogin, role, active: true });
          }}
        >
          <label>
            <span>GitHub username</span>
            <input
              required
              autoComplete="off"
              pattern="[A-Za-z0-9-]{1,39}"
              value={githubLogin}
              onChange={(event) => setGithubLogin(event.target.value)}
            />
          </label>
          <label>
            <span>Role</span>
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {roles.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <button className="button button--primary">Add person</button>
        </form>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>GitHub account</th>
                <th>Role</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {roleItems.map((item) => (
                <tr key={item.githubUserId}>
                  <td>@{item.githubLogin}</td>
                  <td>
                    <select
                      aria-label={`Role for ${item.githubLogin}`}
                      value={item.role}
                      onChange={(event) =>
                        void save({
                          githubLogin: item.githubLogin,
                          role: event.target.value as Role,
                          active: item.active,
                        })
                      }
                    >
                      {roles.map((candidate) => (
                        <option key={candidate}>{candidate}</option>
                      ))}
                    </select>
                  </td>
                  <td>{item.active ? 'Active' : 'Disabled'}</td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      onClick={() =>
                        void save({
                          githubLogin: item.githubLogin,
                          role: item.role,
                          active: !item.active,
                        })
                      }
                    >
                      {item.active ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="admin-card" aria-labelledby="audit-title">
        <h3 id="audit-title">Recent audit activity</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.occurredAt).toLocaleString()}</td>
                  <td>{item.actor.startsWith('@') ? item.actor : 'System'}</td>
                  <td>
                    <strong>{auditActionLabel(item.action)}</strong>
                    {auditDetails(item.metadata) ? (
                      <small className="table-detail">{auditDetails(item.metadata)}</small>
                    ) : null}
                  </td>
                  <td>{auditTargetLabel(item.targetType, item.targetId)}</td>
                  <td>
                    <span className={`status-badge status-badge--${item.outcome}`}>
                      {auditOutcomeLabel(item.outcome)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
