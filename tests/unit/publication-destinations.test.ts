import { publicationDestination } from '../../src/server/publish/destinations';

it('binds each Builder to its own staging and public site', () => {
  const canary = 'https://builder-canary.eaglepass.io';
  expect(publicationDestination('staging', canary)).toMatchObject({
    repository: 'pointsite-staging-canary',
    id: '1370792530',
    origin: 'https://staging-canary.pointatx.org',
  });
  expect(publicationDestination('production', canary)).toMatchObject({
    repository: 'pointsite-canary',
    id: '1373215793',
    origin: 'https://canary.pointatx.org',
    environment: 'github-pages',
  });
  expect(publicationDestination('staging', 'https://builder.eaglepass.io').repository).toBe(
    'pointsite-staging',
  );
  expect(publicationDestination('production', 'https://builder.eaglepass.io').repository).toBe(
    'pointsite',
  );
});
