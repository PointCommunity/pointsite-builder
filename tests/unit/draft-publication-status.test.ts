import {
  publicationExplanation,
  publicationLabel,
} from '../../src/client/drafts/publication-status';

it('keeps baseline and display count separate from immutable sequence', () => {
  expect(
    publicationLabel({ sourceTarget: 'production', state: 'published', displayCount: 0 }, 1),
  ).toBe('Published - Revision 0');
  expect(
    publicationLabel({ sourceTarget: 'production', state: 'published', displayCount: 2 }, 8),
  ).toBe('Published - Revision 2');
  expect(
    publicationLabel({ sourceTarget: 'production', state: 'behind', displayCount: 2 }, 8),
  ).toBe('Behind public site - Revision 2');
  expect(publicationLabel({ sourceTarget: 'staging', state: 'unknown', displayCount: 0 }, 1)).toBe(
    'Unknown public site baseline - Revision 0',
  );
});

it('names the Staging source without claiming its content is live on Production', () => {
  expect(
    publicationExplanation({
      sourceTarget: 'staging',
      state: 'published',
      displayCount: 3,
    }),
  ).toContain('copied from Staging');
  expect(
    publicationExplanation({
      sourceTarget: 'staging',
      state: 'published',
      displayCount: 3,
    }),
  ).toContain('not necessarily live on the public site');
});
