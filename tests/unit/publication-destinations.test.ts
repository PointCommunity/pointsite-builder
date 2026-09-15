import { publicationDestination } from '../../src/server/publish/destinations';

it('binds Canary to its isolated site and rejects higher-environment publication', () => {
  const canary = 'https://builder-canary.eaglepass.io';
  expect(publicationDestination('staging', canary)).toMatchObject({
    repository: 'pointsite-staging-canary',
    id: '1370792530',
    origin: 'https://staging-canary.pointatx.org',
  });
  expect(() => publicationDestination('production', canary)).toThrow(
    'PUBLISH_DESTINATION_REJECTED',
  );
  expect(publicationDestination('staging', 'https://builder.eaglepass.io').repository).toBe(
    'pointsite-staging',
  );
  expect(publicationDestination('production', 'https://builder.eaglepass.io').repository).toBe(
    'pointsite',
  );
});
