import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../../src/client/api';
import { ProductionRollback } from '../../src/client/publish/ProductionRollback';

afterEach(() => vi.restoreAllMocks());
it('requires an explicit release choice and retains the exact request after a lost capture reply', async () => {
  vi.spyOn(api, 'getRollback').mockResolvedValue({
    enabled: true,
    releases: [
      {
        id: 'baseline',
        kind: 'baseline',
        verifiedAt: '2026-09-13T00:00:00Z',
        artifactDigest: 'a'.repeat(64),
      },
    ],
    job: null,
    publicationJobId: null,
  });
  const prepared = {
    baseSha: 'b'.repeat(40),
    previousDeploymentId: '123',
    previousReleaseId: 'baseline',
  };
  const prepare = vi.spyOn(api, 'prepareRollback').mockResolvedValue(prepared);
  const restore = vi
    .spyOn(api, 'rollbackProduction')
    .mockRejectedValueOnce(new Error('lost reply'))
    .mockResolvedValue({ id: 'job', status: 'queued' });
  render(<ProductionRollback onRefresh={async () => {}} />);
  expect(await screen.findByRole('button', { name: 'Prepare selected restore' })).toBeDisabled();
  expect(prepare).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Verified release'), { target: { value: 'baseline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare selected restore' }));
  const button = await screen.findByRole('button', {
    name: 'Restore selected release to Production',
  });
  await waitFor(() => expect(button).toBeEnabled());
  expect(restore).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
  fireEvent.click(button);
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
  expect(restore.mock.calls[0]).toEqual([
    { ...prepared, sourceReleaseId: 'baseline' },
    expect.any(String),
  ]);
  expect(restore.mock.calls[1]).toEqual(restore.mock.calls[0]);
});

it('shows saved rollback progress without automatically publishing or releasing its lock', async () => {
  vi.spyOn(api, 'getRollback').mockResolvedValue({
    enabled: true,
    releases: [],
    publicationJobId: null,
    job: {
      id: 'job',
      status: 'running',
      sourceReleaseId: 'baseline',
      requestedAt: '2026-09-13T00:00:00Z',
      attempts: 1,
      canVerify: true,
      workflowUrl: 'https://github.com/PointCommunity/pointsite/actions/runs/123',
    },
  });
  const recover = vi.spyOn(api, 'recoverRollback').mockResolvedValue({ recovered: true });
  render(<ProductionRollback onRefresh={async () => {}} />);
  expect(await screen.findByText(/Rollback needs attention/)).toBeVisible();
  expect(screen.queryByLabelText('Verified release')).toBeNull();
  expect(recover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Verify completed rollback' }));
  await waitFor(() => expect(recover).toHaveBeenCalledWith('job', 'verify'));
});
