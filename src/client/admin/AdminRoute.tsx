import { useEffect, useState } from 'react';
import type { Role } from '../../server/repositories/contracts';
import { api, type AdminRoleItem, type AuditItem, type CapacityReport } from '../api';

const roles: Role[] = ['viewer', 'editor', 'publisher', 'administrator'];
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;

function Capacity({ report }: { report: CapacityReport }) {
  const items = [
    ['Private media', report.privateMedia],
    ['Revision data', report.revisionData],
    ['Writes today', report.writesToday],
  ] as const;
  return (
    <section className="admin-card" aria-labelledby="capacity-title">
      <h3 id="capacity-title">Capacity</h3>
      <div className="capacity-grid">
        {items.map(([label, item]) => (
          <div
            className={item.warning ? 'capacity-meter capacity-meter--warning' : 'capacity-meter'}
            key={label}
          >
            <div>
              <strong>{label}</strong>
              <span>
                {item.unit === 'bytes'
                  ? `${bytes(item.used)} of ${bytes(item.limit)}`
                  : `${item.used.toLocaleString()} of ${item.limit.toLocaleString()}`}
              </span>
            </div>
            <progress value={item.percent} max="100">
              {item.percent}%
            </progress>
            <span>
              {item.percent}%{item.warning ? ' — action recommended' : ''}
            </span>
          </div>
        ))}
      </div>
      <small>Measured {new Date(report.measuredAt).toLocaleString()}. Warnings begin at 70%.</small>
    </section>
  );
}

export function AdminRoute() {
  const [roleItems, setRoleItems] = useState<AdminRoleItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [capacity, setCapacity] = useState<CapacityReport | null>(null);
  const [email, setEmail] = useState('');
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
  const save = async (input: { email: string; role: Role; active: boolean }) => {
    setStatus(`Saving ${input.email}…`);
    try {
      await api.upsertRole(input);
      await load();
      setEmail('');
      setStatus(`${input.email} updated`);
    } catch {
      setStatus(`${input.email} could not be updated`);
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
            void save({ email, role, active: true });
          }}
        >
          <label>
            <span>Email</span>
            <input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
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
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {roleItems.map((item) => (
                <tr key={item.email}>
                  <td>{item.email}</td>
                  <td>
                    <select
                      aria-label={`Role for ${item.email}`}
                      value={item.role}
                      onChange={(event) =>
                        void save({
                          email: item.email,
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
                        void save({ email: item.email, role: item.role, active: !item.active })
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
                  <td>{item.actor}</td>
                  <td>{item.action}</td>
                  <td>
                    {item.targetType}: {item.targetId}
                  </td>
                  <td>{item.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
