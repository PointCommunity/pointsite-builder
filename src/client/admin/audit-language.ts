import {
  DraftActionCategorySchema,
  DraftActionContextSchema,
  draftActionCategoryLabel,
  draftActionContextLabel,
} from '../../shared/draft-actions';

const actions: Record<string, string> = {
  'draft.create': 'Created a draft',
  'draft.save': 'Saved draft changes',
  'draft.rename': 'Renamed a draft',
  'draft.active': 'Unarchived a draft',
  'draft.archived': 'Archived a draft',
  'draft.deleted': 'Deleted a draft',
  'revision.label': 'Named a revision',
  'media.upload': 'Uploaded an image',
  'media.metadata.update': 'Updated media details',
  'media.orphan': 'Marked unused media for cleanup',
  'media.delete': 'Deleted unused media',
  'role.upsert': 'Changed Builder access',
  'publish.queued': 'Started a staging publish',
  'publish.running': 'Staging publish began',
  'publish.succeeded': 'Published to staging',
  'publish.failed': 'Staging publish failed',
  'publish.preflight-passed': 'Private staging check passed',
  'publish.preflight-failed': 'Private staging check failed',
  'publish.denied': 'Staging was already in use',
  'publish.lease-recovered': 'Recovered an expired staging publish',
  'publish.verification-recorded': 'Recorded staging checks',
  'approval.approved': 'Accepted a staging candidate',
};
const targets: Record<string, string> = {
  draft: 'Draft',
  revision: 'Revision',
  media: 'Library item',
  role: 'GitHub account',
  'publish-job': 'Staging publish',
  'publish-preflight': 'Private staging check',
  approval: 'Acceptance',
  'audit-event': 'Audit entry',
};

export function auditActionLabel(value: string): string {
  return (
    actions[value] ??
    value
      .split('.')
      .join(' ')
      .replace(/^./, (letter) => letter.toUpperCase())
  );
}

export function auditTargetLabel(type: string, id: string): string {
  const label =
    targets[type] ?? type.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
  return id.startsWith('@') ? `${label} ${id}` : label;
}

export function auditOutcomeLabel(value: string): string {
  return value === 'succeeded' ? 'Completed' : value === 'denied' ? 'Blocked' : 'Failed';
}

export function auditDetails(metadata: Record<string, string | number | boolean | null>): string {
  return Object.entries(metadata)
    .filter(
      ([key, value]) =>
        value !== null && !/(?:id$|sha|checksum|objectkey|idempotencykey)/i.test(key),
    )
    .map(([key, value]) => {
      if (key === 'sequence') return `Revision ${String(value)}`;
      if (key === 'actionCategory') {
        const category = DraftActionCategorySchema.safeParse(value);
        return category.success ? `Action: ${draftActionCategoryLabel(category.data)}` : '';
      }
      if (key === 'actionContext') {
        const context = DraftActionContextSchema.safeParse(value);
        return context.success ? `Area: ${draftActionContextLabel(context.data)}` : '';
      }
      const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase());
      const friendlyValue =
        typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value).replaceAll('_', ' ');
      return `${label}: ${friendlyValue}`;
    })
    .filter(Boolean)
    .join(' · ');
}
