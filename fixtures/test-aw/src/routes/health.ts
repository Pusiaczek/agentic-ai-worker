import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox';
import { sql } from 'drizzle-orm';

const HealthResponse = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('error')]),
});

export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/health',
    { schema: { response: { 200: HealthResponse, 503: HealthResponse } } },
    async (request, reply) => {
      try {
        await app.db.execute(sql`select 1`);
        return { status: 'ok' } as const;
      } catch (err) {
        request.log.error({ err }, 'health check: database unreachable');
        return reply.code(503).send({ status: 'error' });
      }
    },
  );
};
