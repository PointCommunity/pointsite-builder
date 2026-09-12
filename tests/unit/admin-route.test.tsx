import { render, screen } from '@testing-library/react';
import { AdminRoute } from '../../src/client/admin/AdminRoute';
import { api } from '../../src/client/api';

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
