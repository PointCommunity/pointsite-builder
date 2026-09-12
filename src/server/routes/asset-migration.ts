import { Hono } from 'hono';
import type { D1OwnershipMigration } from '../maintenance/asset-migration';
import { requireRole } from '../auth/roles';
import { ApiError } from '../http/errors';
import type { ApiVariables } from './drafts';

export function createAssetMigrationRoutes(service: D1OwnershipMigration | undefined) {
  const routes = new Hono<{ Variables: ApiVariables }>();
  routes.use('*', async (context, next) => {
    requireRole(context.get('actor'), 'administrator');
    await next();
  });
  routes.get('/', async (context) => {
    if (!service)
      throw new ApiError(
        503,
        'ASSET_MIGRATION_NOT_CONFIGURED',
        'Draft media migration is not configured',
      );
    return context.json(await service.status());
  });
  return routes;
}
