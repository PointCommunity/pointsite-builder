import { render, screen } from '@testing-library/react';
import { AdminRoute } from '../../src/client/admin/AdminRoute';
import { api } from '../../src/client/api';

it.each(['reported', 'stale'] as const)(
  'shows %s provider counters with their UTC period and collection time',
  async (state) => {
    vi.spyOn(api, 'listRoles').mockResolvedValue([]);
    vi.spyOn(api, 'listAudit').mockResolvedValue([]);
    vi.spyOn(api, 'getCapacity').mockResolvedValue({
      storage: {
        allocatedBytes: 8388608,
        privateMediaBytes: 1048576,
        revisionPayloadBytes: 2097152,
        receiptPayloadBytes: 3145728,
      },
      activity: {
        auditEvents: 27,
        periodStart: '2026-09-12T00:00:00.000Z',
        periodEnd: '2026-09-12T12:00:00.000Z',
      },
      providerUsage: {
        state,
        reason: 'Provider analytics can arrive late.',
        checkedAt: '2026-09-12T12:10:00.000Z',
        collectedAt: '2026-09-12T12:00:01.000Z',
        sample: {
          periodStart: '2026-09-12T00:00:00.000Z',
          periodEnd: '2026-09-12T12:00:00.000Z',
          account: { rowsRead: 123456, rowsWritten: 1234 },
          workspace: { rowsRead: 23456, rowsWritten: 234 },
          workspaceStorageBytes: 4194304,
        },
      },
      measuredAt: '2026-09-12T12:10:00.000Z',
    });
    render(<AdminRoute />);
    expect(
      await screen.findByRole('heading', {
        name: state === 'stale' ? 'Provider analytics — stale' : 'Provider analytics',
      }),
    ).toBeVisible();
    expect(screen.getByText('123,456 / 1,234')).toBeVisible();
    expect(screen.getByText('23,456 / 234')).toBeVisible();
    expect(screen.getByText('4.0 MiB')).toBeVisible();
    expect(screen.getByText(/Requested period:.*GMT/)).toBeVisible();
    expect(screen.getByText(/Collected.*Last refresh attempt/)).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  },
);

it('shows measured payloads and unknown provider usage without a misleading quota meter', async () => {
  vi.spyOn(api, 'listRoles').mockResolvedValue([]);
  vi.spyOn(api, 'listAudit').mockResolvedValue([]);
  vi.spyOn(api, 'getCapacity').mockResolvedValue({
    storage: {
      allocatedBytes: null,
      privateMediaBytes: 1048576,
      revisionPayloadBytes: 2097152,
      receiptPayloadBytes: 3145728,
    },
    activity: {
      auditEvents: 27,
      periodStart: '2026-09-12T00:00:00.000Z',
      periodEnd: '2026-09-12T12:00:00.000Z',
    },
    providerUsage: { state: 'unknown', reason: 'Provider counters unavailable.' },
    measuredAt: '2026-09-12T12:00:00.000Z',
  });
  render(<AdminRoute />);
  expect(
    await screen.findByText('Provider usage: unknown. Provider counters unavailable.'),
  ).toBeVisible();
  expect(screen.getByText('1.0 MiB')).toBeVisible();
  expect(screen.getByText('Unknown')).toBeVisible();
  expect(screen.getByText(/27 audit events since/)).toBeVisible();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});
