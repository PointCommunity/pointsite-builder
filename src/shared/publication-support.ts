/** Export operational evidence only. Drafts, identities and credentials never belong in support. */
const fields = new Set(
  `id status code message requestId error phase stage checkedAt unavailable
  failureCode workflowUrl deploymentUrl commitUrl origin repository enabled busy destination
  draftId revisionId revisionChecksum sequence checksum candidateChecksum schemaVersion rendererVersion
  stagingBaseSha stagingCommitSha baseSha commitSha currentStagingSha requestedAt completedAt
  createdAt validatedAt artifactDigest publicationProtocol workflowRevision approvalId stagingJobId
  publishJobId decision tuple preflight state reason availability job approval dispatch evidence
  attempts retryAt needsAttention reserved canReconcileStopped canRetryCaptured canVerifyCompleted
  canVerifyOutput verificationStatus verification failedChecks failedCheckUrls checks
  dispatchRevision runId checkRunId attempt dispatchAttempts reported sourceReleaseId
  previousReleaseId previousDeploymentId publicationJobId canVerify actions name number
  conclusion jobs steps errors errorsUnavailable title summary stopped capturedAt reviewUrl path line`.split(
    /\s+/,
  ),
);

export function supportText(value: string): string {
  return (
    value
      .replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
        try {
          const url = new URL(raw);
          url.username = '';
          url.password = '';
          url.search = '';
          url.hash = '';
          return url.toString();
        } catch {
          return '[link unavailable]';
        }
      })
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
        '[redacted]',
      )
      .replace(
        /\b(?:token|password|secret|authorization|cookie|nonce)\s*[:=]\s*\S+/gi,
        '[redacted]',
      )
      // Strip nonprinting controls from provider text while retaining line breaks.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .slice(0, 4000)
  );
}

export function supportJson(value: unknown): string {
  const clean = (item: unknown, depth = 0, map = false): unknown => {
    if (depth > 12) return '[omitted]';
    if (typeof item === 'string') return supportText(item);
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (Array.isArray(item)) return item.slice(0, 100).map((entry) => clean(entry, depth + 1));
    if (!item || typeof item !== 'object') return undefined;
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => map || fields.has(key))
        .map(([key, entry]) => [
          supportText(key),
          clean(entry, depth + 1, key === 'checks' || key === 'failedCheckUrls'),
        ]),
    );
  };
  return JSON.stringify(clean(value), null, 2);
}
