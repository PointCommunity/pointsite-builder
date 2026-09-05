import { Hono } from 'hono';

type Bindings = {
  APP_VERSION: string;
  ENVIRONMENT: string;
  PRODUCTION_ENABLED: 'false';
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', (context) =>
  context.json({
    ok: true,
    environment: context.env.ENVIRONMENT,
    version: context.env.APP_VERSION,
    productionEnabled: false,
  }),
);

app.all('/api/*', (context) =>
  context.json(
    {
      code: 'NOT_FOUND',
      message: 'The requested API operation does not exist.',
      requestId: crypto.randomUUID(),
    },
    404,
  ),
);

export default app;
