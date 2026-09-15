import { expect, test } from '@playwright/test';
import type * as JournalModule from '../../src/client/editor/pending-journal';
import type * as DefaultSiteModule from '../../src/site-kit/default-site';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"code":"AUTHENTICATION_REQUIRED","message":"Native journal fixture"}',
    }),
  );
});

test('pending journal survives refresh, isolates actors, rejects stale writers and clears acknowledged payloads', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const source = '/src/client/editor/pending-journal.ts';
    const fixture = '/src/site-kit/default-site.ts';
    const { PendingJournal, PendingJournalError, PENDING_JOURNAL_MAX_AGE } = (await import(
      source
    )) as typeof JournalModule;
    const { defaultSiteDocument } = (await import(fixture)) as typeof DefaultSiteModule;
    const scope = {
      actor: 'journal-test-user',
      draftId: '10000000-0000-4000-8000-000000000001',
      clientId: 'journal-browser-0001',
    };
    const first = new PendingJournal(scope);
    const empty = await first.load();
    const state = {
      version: 1 as const,
      scope,
      baseRevisionId: '20000000-0000-4000-8000-000000000001',
      baseChecksum: 'a'.repeat(64),
      updatedAt: new Date().toISOString(),
      staged: null,
      actions: [
        {
          idempotencyKey: 'pending-action-0001',
          document: structuredClone(defaultSiteDocument),
          action: { category: 'text-edit' as const, context: 'site-settings' as const },
          expectedRevisionId: null,
          expectedChecksum: null,
          ready: false,
        },
      ],
    };
    state.actions[0].document.site.shortName = 'Recover this text';
    await first.write(state);
    const otherScope = { ...scope, actor: 'another-user' };
    const otherWriter = new PendingJournal(otherScope);
    const other = await otherWriter.load();
    await otherWriter.write({ ...state, scope: otherScope });
    const resumed = new PendingJournal(scope);
    const recovered = await resumed.load();
    const rejectedWriter = await first.write(state).then(
      () => false,
      (error: unknown) => error instanceof PendingJournalError && error.code === 'ownership',
    );
    const withSecret = { ...state, checkoutToken: 'forbidden-test-field' };
    const rejectedSecret = await resumed.write(withSecret).then(
      () => false,
      (error: unknown) => error instanceof PendingJournalError && error.code === 'invalid',
    );
    await resumed.write({
      ...state,
      updatedAt: new Date(Date.now() - PENDING_JOURNAL_MAX_AGE - 1000).toISOString(),
    });
    const expired = new PendingJournal(scope);
    const rejectedExpiry = await expired.load().then(
      () => false,
      (error: unknown) => error instanceof PendingJournalError && error.code === 'expired',
    );
    await expired.write(null);
    const cleared = await expired.load();
    await expired.write(state);
    const actorCounts = [
      await PendingJournal.countPending(scope.actor),
      await PendingJournal.countPending(otherScope.actor),
    ];
    const blockedSignout = !(await PendingJournal.prepareSignout(scope.actor));
    await PendingJournal.discardPending(otherScope.actor);
    const retainedActorCounts = [
      await PendingJournal.countPending(scope.actor),
      await PendingJournal.countPending(otherScope.actor),
    ];
    const rejectedAfterSignout = await otherWriter.write({ ...state, scope: otherScope }).then(
      () => false,
      (error: unknown) => error instanceof PendingJournalError && error.code === 'ownership',
    );
    return {
      empty,
      other,
      name: recovered?.actions[0].document.site.shortName,
      rejectedWriter,
      rejectedSecret,
      rejectedExpiry,
      cleared,
      actorCounts,
      blockedSignout,
      retainedActorCounts,
      rejectedAfterSignout,
    };
  });
  expect(result).toEqual({
    empty: null,
    other: null,
    name: 'Recover this text',
    rejectedWriter: true,
    rejectedSecret: true,
    rejectedExpiry: true,
    cleared: null,
    actorCounts: [1, 1],
    blockedSignout: true,
    retainedActorCounts: [1, 0],
    rejectedAfterSignout: true,
  });
  await page.reload();
  const afterRefresh = await page.evaluate(async () => {
    const source = '/src/client/editor/pending-journal.ts';
    const { PendingJournal } = (await import(source)) as typeof JournalModule;
    const journal = new PendingJournal({
      actor: 'journal-test-user',
      draftId: '10000000-0000-4000-8000-000000000001',
      clientId: 'journal-browser-0001',
    });
    const state = await journal.load();
    await journal.write(null);
    const cleared = await journal.load();
    const signoutReady = await PendingJournal.prepareSignout(journal.scope.actor);
    const signedOutWriterBlocked = await journal.write(state).then(
      () => false,
      () => true,
    );
    return {
      name: state?.actions[0].document.site.shortName,
      key: state?.actions[0].idempotencyKey,
      base: state?.baseRevisionId,
      cleared,
      signoutReady,
      signedOutWriterBlocked,
    };
  });
  expect(afterRefresh).toEqual({
    name: 'Recover this text',
    key: 'pending-action-0001',
    base: '20000000-0000-4000-8000-000000000001',
    cleared: null,
    signoutReady: true,
    signedOutWriterBlocked: true,
  });
});

test('pending journal enforces the shared 32 MiB budget without replacing existing recovery', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const source = '/src/client/editor/pending-journal.ts';
    const fixture = '/src/site-kit/default-site.ts';
    const { PendingJournal, PendingJournalError } = (await import(source)) as typeof JournalModule;
    const { defaultSiteDocument } = (await import(fixture)) as typeof DefaultSiteModule;
    const scope = {
      actor: 'journal-budget-user',
      draftId: '10000000-0000-4000-8000-000000000001',
      clientId: 'journal-browser-0001',
    };
    const state = {
      version: 1 as const,
      scope,
      baseRevisionId: '20000000-0000-4000-8000-000000000001',
      baseChecksum: 'a'.repeat(64),
      updatedAt: new Date().toISOString(),
      staged: null,
      actions: Array.from({ length: 250 }, () => ({
        idempotencyKey: crypto.randomUUID(),
        document: defaultSiteDocument,
        action: { category: 'text-edit' as const, context: 'site-settings' as const },
        expectedRevisionId: null,
        expectedChecksum: null,
        ready: false,
      })),
    };
    const first = new PendingJournal(scope);
    await first.load();
    await first.write(state);
    const secondScope = { ...scope, actor: 'other-budget-user', clientId: 'journal-browser-0002' };
    const second = new PendingJournal(secondScope);
    await second.load();
    const overBudget = await second.write({ ...state, scope: secondScope }).then(
      () => false,
      (error: unknown) => error instanceof PendingJournalError && error.code === 'quota',
    );
    const preserved = (await first.load())?.actions.length;
    const secondEmpty = await second.load();
    await PendingJournal.discardPending(scope.actor);
    await second.write({ ...state, scope: secondScope });
    const reusable = (await second.load())?.actions.length;
    await second.write(null);
    return { overBudget, preserved, secondEmpty, reusable };
  });
  expect(result).toEqual({ overBudget: true, preserved: 250, secondEmpty: null, reusable: 250 });
});
