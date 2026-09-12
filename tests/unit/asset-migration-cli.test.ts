// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { migrationMode, runMigration } from '../../scripts/migrate-draft-assets';

it('requires one explicit migration mode and defaults to no database operation', () => {
  expect(() => migrationMode([])).toThrow();
  expect(() => migrationMode(['--status', '--apply'])).toThrow();
  expect(() => migrationMode(['--remote'])).toThrow();
  expect(migrationMode(['--status'])).toBe('status');
  expect(migrationMode(['--apply'])).toBe('apply');
});

it('status reads never apply steps; apply resumes until complete', async () => {
  const pending = {
    state: 'pending' as const,
    remainingDrafts: 1,
    legacyAssets: 1,
    legacyBytes: 24,
    recoveredUploads: 0,
  };
  const completed = {
    ...pending,
    state: 'complete' as const,
    remainingDrafts: 0,
    legacyAssets: 0,
    legacyBytes: 0,
  };
  const migration = {
    status: vi.fn().mockResolvedValue(pending),
    step: vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(completed),
  };
  const report = vi.fn();
  await runMigration('status', migration, report);
  expect(migration.step).not.toHaveBeenCalled();
  await runMigration('apply', migration, report);
  expect(migration.step).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith(completed);
});
