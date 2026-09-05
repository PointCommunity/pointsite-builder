export const databaseContract = {
  roles: ['viewer', 'editor', 'publisher', 'administrator'],
  draftStatuses: ['active', 'archived', 'deleted'],
  jobStatuses: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
  approvalDecisions: ['approved', 'rejected', 'revoked'],
  automaticRevisionRetentionDays: 90,
  deletedDraftRecoveryDays: 30,
  orphanMediaDeletionDays: 30,
  auditRetentionDays: 400,
} as const;
