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
        restored: true,
      }),
    ).toBe('Revision 3 · Restored: Yes');
    expect(auditTargetLabel('draft', '273da879-1234')).toBe('Draft');
    expect(auditTargetLabel('role', '@brimdor')).toBe('GitHub account @brimdor');
  });

  it('turns internal action and outcome codes into plain language', () => {
    expect(auditActionLabel('draft.save')).toBe('Saved draft changes');
    expect(auditOutcomeLabel('denied')).toBe('Blocked');
  });
});
