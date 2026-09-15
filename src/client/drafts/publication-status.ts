import type { DraftPublicationStatus } from '../../server/repositories/contracts';

export function publicationLabel(status: DraftPublicationStatus | undefined, sequence: number) {
  const count = status?.displayCount ?? Math.max(0, sequence - 1);
  const prefix =
    status?.state === 'published'
      ? 'Published'
      : status?.state === 'behind'
        ? 'Behind Production'
        : 'Unknown Production baseline';
  return `${prefix} - Revision ${count}`;
}

export function publicationExplanation(status: DraftPublicationStatus | undefined) {
  const baseline =
    status?.state === 'published'
      ? 'This draft has the current Production baseline.'
      : status?.state === 'behind'
        ? 'Production has replaced this draft’s known baseline. Reuse does not require a merge.'
        : 'This draft’s Production baseline cannot be verified. Do not assume it is live.';
  const source =
    status?.sourceTarget === 'staging'
      ? ' This draft was copied from Staging. Staging-only content is not necessarily live on Production.'
      : status?.sourceTarget === 'production'
        ? ' This draft was copied from Production.'
        : ' The original publication source is not proven.';
  const count = status?.displayCount ?? 0;
  return `${baseline}${source} ${count} saved ${count === 1 ? 'edit is' : 'edits are'} not necessarily published. The count does not change immutable History.`;
}
