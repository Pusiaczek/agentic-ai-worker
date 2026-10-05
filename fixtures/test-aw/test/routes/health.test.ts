import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestContext } from '../helpers/app.js';

describe('GET /health', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // The 503 test closes the connection, so these tests never share a database.
    ctx = await buildTestApp({ ownDatabase: true });
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('returns 200 ok when the database answers', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is unreachable', async () => {
    await ctx.client.close();

    const res = await ctx.app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error' });
  });
});
