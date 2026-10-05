import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestContext } from './helpers/app.js';
import { expectBadRequest } from './helpers/users.js';

// Probe routes with schemas but without any per-route validator option (no validatorCompiler,
// no schemaCompiler). They show which validation every route gets from buildApp() by default.
const ProbeBody = Type.Object({ text: Type.String(), count: Type.Optional(Type.Integer()) });
const ProbeQuery = Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 100, default: 20 }) });
const ProbeParams = Type.Object({ n: Type.Integer() });

/** Registered like the resource plugins in src/routes (an encapsulated plugin with a prefix). */
const probePlugin: FastifyPluginAsyncTypebox = async (app) => {
  app.post('/body', { schema: { body: ProbeBody } }, async (request) => ({
    text: request.body.text,
    textType: typeof request.body.text,
    count: request.body.count,
    countType: typeof request.body.count,
  }));

  app.get('/query', { schema: { querystring: ProbeQuery } }, async (request) => ({
    limit: request.query.limit,
    limitType: typeof request.query.limit,
  }));

  app.get('/params/:n', { schema: { params: ProbeParams } }, async (request) => ({
    n: request.params.n,
    nType: typeof request.params.n,
  }));
};

let ctx: TestContext;

beforeEach(async () => {
  ctx = await buildTestApp();

  ctx.app.register(probePlugin, { prefix: '/probe' });
  // Also one route directly on the instance buildApp() returns, outside any plugin.
  ctx.app.post('/root-probe/body', { schema: { body: ProbeBody } }, async (request) => ({
    text: request.body.text,
    textType: typeof request.body.text,
    count: request.body.count,
    countType: typeof request.body.count,
  }));
});

afterEach(async () => {
  await ctx.app.close();
});

const BODY_ROUTES = [
  ['a route in a registered plugin', '/probe/body'],
  ['a route on the root instance', '/root-probe/body'],
] as const;

describe.each(BODY_ROUTES)('buildApp(): request body of %s', (_label, url) => {
  const post = (payload: object) => ctx.app.inject({ method: 'POST', url, payload });

  it.each([
    ['a number', 123],
    ['zero', 0],
    ['a boolean', true],
    ['false', false],
    ['an array holding a string', ['abc']],
    ['null', null],
    ['an object', { value: 'abc' }],
  ])(
    'returns 400 for %s where the schema requires a string (no type coercion)',
    async (_l, text) => {
      expectBadRequest(await post({ text }));
    },
  );

  it('returns 400 for a numeric string where the schema requires an integer (no type coercion)', async () => {
    expectBadRequest(await post({ text: 'abc', count: '5' }));
  });

  it('accepts values of the declared types and passes them to the handler unchanged', async () => {
    const res = await post({ text: '123', count: 5 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: '123', textType: 'string', count: 5, countType: 'number' });
  });
});

describe('buildApp(): querystring and path params keep coercion and defaults', () => {
  it('coerces ?limit=5 from the querystring to the number 5', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/probe/query?limit=5' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ limit: 5, limitType: 'number' });
  });

  it('applies the querystring default when the parameter is missing', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/probe/query' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ limit: 20, limitType: 'number' });
  });

  it.each(['limit=abc', 'limit=1.5', 'limit=0'])(
    'still validates the querystring: returns 400 for ?%s',
    async (query) => {
      expectBadRequest(await ctx.app.inject({ method: 'GET', url: `/probe/query?${query}` }));
    },
  );

  it('coerces an integer path param to a number', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/probe/params/7' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ n: 7, nType: 'number' });
  });

  it('still validates path params: returns 400 for a non-integer', async () => {
    expectBadRequest(await ctx.app.inject({ method: 'GET', url: '/probe/params/abc' }));
  });
});
