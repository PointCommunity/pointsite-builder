import { render, screen } from '@testing-library/react';
import { PublicationProgress } from '../../src/client/publish/PublicationProgress';
import { PublishingDetails, PublishingSupport } from '../../src/client/publish/PublishingSupport';

it('shows confirmed milestones and keeps timestamps in collapsed technical details', () => {
  render(
    <PublishingSupport>
      <PublicationProgress
        job={{
          status: 'running',
          dispatch: {
            stage: 'preparing',
            attempts: 1,
            reserved: true,
            retryAt: '',
            needsAttention: false,
          },
        }}
        checkedAt="2026-09-21T13:12:00Z"
      />
      <PublishingDetails />
    </PublishingSupport>,
  );
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  expect(screen.getByRole('list', { name: 'Publication steps' })).toBeVisible();
  expect(screen.getByText(/Last successful status check/)).not.toBeVisible();
});

it('freezes confirmed progress when status is unavailable', () => {
  render(
    <PublicationProgress
      stale
      job={{
        status: 'running',
        dispatch: {
          stage: 'building',
          attempts: 1,
          reserved: true,
          retryAt: '',
          needsAttention: false,
        },
      }}
    />,
  );
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'aria-valuetext',
    expect.stringContaining('unavailable'),
  );
});
