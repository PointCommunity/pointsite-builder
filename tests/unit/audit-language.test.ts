import { describe, expect, it } from 'vitest';
import {
  auditActionLabel,
  auditDetails,
  auditOutcomeLabel,
  auditTargetLabel,
} from '../../src/client/admin/audit-language';

describe('friendly audit language', () => {
  it('keeps technical identifiers out of the primary audit summary', () => {
    expect(
      auditDetails({
        revisionId: '5a23d2eb-e56d-45f3-954e-d4ba9286df1f',
        sequence: 3,
        requestId: 'internal-request',
        commitSha: '1f56361a106c64233459e2c926c0182f97e7e22a',
        candidateChecksum: 'd786424ae1b897d7edafb7914c1e4e6c16b962acca93a151faa474019f25111b',
        productionBaseSha: '0187c95c8a9d3441049616a801f66f6f6d11050e',
        restored: true,
        actionCategory: 'text-edit',
        actionContext: 'page-details',
      }),
    ).toBe('Revision 3 · Restored: Yes · Action: Edited text · Area: Page details');
    expect(auditTargetLabel('draft', '273da879-1234')).toBe('Draft');
    expect(auditTargetLabel('role', '@brimdor')).toBe('GitHub account @brimdor');
  });

  it('turns internal action and outcome codes into plain language', () => {
    expect(auditActionLabel('draft.save')).toBe('Saved draft changes');
    expect(auditOutcomeLabel('denied')).toBe('Blocked');
  });
});
