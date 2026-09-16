/** Fixed deployment identities. Requests and draft content cannot select destinations. */
export const publicationDestinations = {
  staging: {
    repository: 'pointsite-staging',
    id: '1357847426',
    environment: 'staging',
    origin: 'https://staging.pointatx.org',
  },
  canary: {
    repository: 'pointsite-staging-canary',
    id: '1370792530',
    environment: 'staging',
    origin: 'https://staging-canary.pointatx.org',
  },
  production: {
    repository: 'pointsite',
    id: '1348084954',
    environment: 'github-pages',
    origin: 'https://pointatx.org',
  },
  publicCanary: {
    repository: 'pointsite-canary',
    id: '1373215793',
    environment: 'github-pages',
    origin: 'https://canary.pointatx.org',
  },
} as const;

export type PublicationRepository =
  (typeof publicationDestinations)[keyof typeof publicationDestinations]['repository'];
export type StagingRepository =
  'PointCommunity/pointsite-staging' | 'PointCommunity/pointsite-staging-canary';

export function publicationDestination(target: 'staging' | 'production', builderOrigin?: string) {
  if (builderOrigin === 'https://builder-canary.eaglepass.io') {
    return target === 'production'
      ? publicationDestinations.publicCanary
      : publicationDestinations.canary;
  }
  return publicationDestinations[target];
}
