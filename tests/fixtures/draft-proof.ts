import type { DraftMutationProof, DraftRepository } from '../../src/server/repositories/contracts';

/** Acquire a real fixture lease; callers testing stale or revoked proof retain their own proof. */
export async function acquireDraftProof(
  repository: DraftRepository,
  draftId: string,
  actor: string,
): Promise<DraftMutationProof> {
  const draft = await repository.getDraft(draftId);
  if (draft.status === 'deleted') throw new Error('Cannot acquire a deleted draft');
  const checkout = await repository.acquireCheckout({
    draftId,
    actor,
    clientId: 'metadata-fixture-client',
    requestId: 'fixture-checkout',
    expectedStatus: draft.status,
  });
  return {
    expectedRevisionId: draft.latestRevisionId,
    expectedChecksum: draft.revision.checksum,
    checkoutToken: checkout.token,
  };
}
