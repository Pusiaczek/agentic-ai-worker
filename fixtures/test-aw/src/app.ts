import { AjvCompiler, type BuildCompilerFromPool } from '@fastify/ajv-compiler';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Db } from './db/index.js';
import { healthRoutes } from './routes/health.js';
import { usersRoutes } from './routes/users.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export interface AppOptions {
  db: Db;
  logger?: FastifyServerOptions['logger'];
}

/**
 * Fastify's default Ajv validator factory, except that request bodies are validated without type
 * coercion. Fastify's Ajv uses `coerceTypes: 'array'` for every request part, which would turn a
 * body's 123, true or ['a'] into a string and null into ''. Bodies get a second instance of the
 * same Ajv with `coerceTypes: false`. Querystring, params and headers keep the coercing one
 * ('?limit=5' → 5, defaults applied).
 *
 * With a custom factory Fastify no longer lowercases the property names in `headers` schemas, so
 * write header names in lowercase there.
 */
function validatorFactory(): BuildCompilerFromPool {
  const fromPool = AjvCompiler();
  return (externalSchemas, options) => {
    const coercing = fromPool(externalSchemas, options);
    // Ajv's JTD mode never coerces types; only the JSON Schema mode needs a second instance.
    if (options?.mode === 'JTD') return coercing;
    const nonCoercing = fromPool(externalSchemas, {
      ...options,
      customOptions: { ...options?.customOptions, coerceTypes: false },
    });
    // Fastify passes a route definition ({ schema, method, url, httpPart }), which the
    // @fastify/ajv-compiler types describe as a plain schema object.
    return (route, meta) =>
      typeof route === 'object' && route.httpPart === 'body'
        ? nonCoercing(route, meta)
        : coercing(route, meta);
  };
}

/** Builds the Fastify app without listening. Dependencies are injected so tests can swap them. */
export function buildApp({ db, logger = false }: AppOptions) {
  const app = Fastify({
    logger,
    schemaController: { compilersFactory: { buildValidator: validatorFactory() } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('db', db);
  app.register(healthRoutes);
  app.register(usersRoutes, { prefix: '/users' });

  return app;
}

export type App = ReturnType<typeof buildApp>;
