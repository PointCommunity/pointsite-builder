import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  CopyPublishingDetails,
  PublishingSupport,
  usePublishingSupport,
} from '../../src/client/publish/PublishingSupport';

function Evidence({ recovered = false }: { recovered?: boolean }) {
  usePublishingSupport('Staging', {
    id: 'staging-job',
    error: recovered ? null : { code: 'BUILD_FAILED', requestId: 'staging-request' },
  });
  usePublishingSupport('Public website', {
    id: 'production-job',
    evidence: { failureCode: 'DEPLOY_FAILED' },
  });
  usePublishingSupport('Restore', {
    id: 'restore-job',
    workflowUrl: 'https://github.com/PointCommunity/pointsite/actions/runs/123',
  });
  return <CopyPublishingDetails />;
}

it('copies every publishing surface together and provides selected text when clipboard is denied', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const view = render(
    <PublishingSupport>
      <Evidence />
    </PublishingSupport>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy support details' }));
  const field = await screen.findByRole('textbox', { name: 'Support details to copy' });
  expect(field).toHaveFocus();
  for (const value of [
    'staging-job',
    'BUILD_FAILED',
    'production-job',
    'DEPLOY_FAILED',
    'restore-job',
    '/actions/runs/123',
  ])
    expect((field as HTMLTextAreaElement).value).toContain(value);
  expect((field as HTMLTextAreaElement).selectionEnd).toBe(
    (field as HTMLTextAreaElement).value.length,
  );
  view.rerender(
    <PublishingSupport>
      <Evidence recovered />
    </PublishingSupport>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy support details' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(screen.getByRole('status')).toHaveTextContent('Copied.');
  expect(writeText.mock.calls[1][0]).toContain('Recent errors');
  expect(writeText.mock.calls[1][0]).toContain('BUILD_FAILED');
});
