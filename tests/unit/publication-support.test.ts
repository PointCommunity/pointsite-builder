import { describe, expect, it } from 'vitest';
import { supportJson } from '../../src/shared/publication-support';

describe('publication support export', () => {
  it('keeps errors and evidence while excluding private content and credentials', () => {
    const output = supportJson({
      id: 'publication-123',
      status: 'failed',
      failureCode: 'PUBLISH_DISPATCH_UNCONFIRMED',
      requestId: 'request-456',
      workflowUrl: 'https://github.com/PointCommunity/pointsite/actions/runs/123?token=secret',
      document: { title: 'Private draft' },
      token: 'session-secret',
      nonce: 'nonce-secret',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Bearer abcdef-secret ghp_abcdefghijklmnopqrstuvwx',
      },
    });
    expect(output).toContain('publication-123');
    expect(output).toContain('PUBLISH_DISPATCH_UNCONFIRMED');
    expect(output).toContain('request-456');
    expect(output).toContain('https://github.com/PointCommunity/pointsite/actions/runs/123');
    for (const value of [
      'Private draft',
      'session-secret',
      'nonce-secret',
      'abcdef-secret',
      'ghp_',
      '?token=',
    ])
      expect(output).not.toContain(value);
  });
});
