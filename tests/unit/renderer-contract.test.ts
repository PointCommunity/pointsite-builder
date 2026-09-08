// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { STAGING_RENDERER_CONTRACT } from '../../src/server/publish/renderer-contract';

describe('protected Staging renderer contract', () => {
  it('pins every canonical Builder site-kit file to its current Git blob identity', () => {
    expect(Object.keys(STAGING_RENDERER_CONTRACT)).toHaveLength(16);
    for (const [filename, expectedBlob] of Object.entries(STAGING_RENDERER_CONTRACT)) {
      const observed = execFileSync('git', ['hash-object', `src/site-kit/${filename}`], {
        encoding: 'utf8',
      }).trim();
      expect(observed, filename).toBe(expectedBlob);
    }
  });
});
