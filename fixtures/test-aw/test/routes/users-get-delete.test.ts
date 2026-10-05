import { describe, expect, it } from 'vitest';
import {
  expectBadRequest,
  expectNotFound,
  expectTimestampBetween,
  expectUserJson,
  findUserRow,
  insertUser,
  MISSING_ID,
  type UserJson,
} from '../helpers/users.js';
import {
  createUser,
  ctx,
  deleteUser,
  getUser,
  LONG_AGO,
  patchUser,
  send,
  useFreshApp,
} from '../helpers/users-routes.js';

useFreshApp();

describe('GET /users/:id', () => {
  it('returns 200 and the user for an existing active user', async () => {
    const row = await insertUser(ctx.db, {
      email: 'Bob@Example.com',
      name: 'Bob',
      createdAt: new Date('2024-03-01T10:00:00.123Z'),
      updatedAt: new Date('2024-03-02T11:30:00.456Z'),
    });

    const res = await getUser(row.id);

    expect(res.statusCode).toBe(200);
    expectUserJson(res.json(), row);
    expect(res.json()).not.toHaveProperty('deletedAt');
  });

  it('returns 404 for a user that is soft-deleted in the database', async () => {
    const row = await insertUser(ctx.db, { deletedAt: LONG_AGO });

    expectNotFound(await getUser(row.id));
  });
});

describe('/users/:id with unknown or malformed ids', () => {
  const METHODS = ['GET', 'PATCH', 'DELETE'] as const;
  const validPatch = { name: 'Valid Name' };
  const call = (method: (typeof METHODS)[number], id: string) =>
    send(method, `/users/${id}`, method === 'PATCH' ? validPatch : undefined);

  it.each(METHODS)(
    '%s /users/:id returns 404 Not Found for a well-formed UUID that matches no user',
    async (method) => {
      await insertUser(ctx.db);

      expectNotFound(await call(method, MISSING_ID));
    },
  );

  const INVALID_IDS = [
    { label: "'abc'", id: 'abc' },
    { label: "'123'", id: '123' },
    { label: 'a UUID with a character missing', id: MISSING_ID.slice(0, -1) },
    { label: 'a UUID with an extra character', id: `${MISSING_ID}0` },
    { label: "a 'urn:uuid:' prefixed UUID", id: `urn:uuid:${MISSING_ID}` },
    { label: 'a UUID without hyphens', id: MISSING_ID.replaceAll('-', '') },
    {
      label: 'a UUID with hyphens in non-canonical places',
      id: '3f1c2b4a-9d8e4f7a-8b6c-5d4e-3f2a1b0c',
    },
    { label: 'a UUID wrapped in braces', id: `%7B${MISSING_ID}%7D` },
    { label: 'a UUID with a non-hex character', id: `${MISSING_ID.slice(0, -1)}g` },
  ];
  const invalidIdCases = METHODS.flatMap((method) =>
    INVALID_IDS.map(({ label, id }) => ({ method, label, id })),
  );

  it.each(invalidIdCases)(
    '$method /users/:id returns 400 when :id is $label',
    async ({ method, id }) => {
      const row = await insertUser(ctx.db);

      expectBadRequest(await call(method, id));
      expect(await findUserRow(ctx.db, row.id)).toEqual(row);
    },
  );

  it('GET /users/:id accepts an uppercase-hex UUID and returns the user with a lowercase id', async () => {
    const row = await insertUser(ctx.db);

    const res = await getUser(row.id.toUpperCase());

    expect(res.statusCode).toBe(200);
    expectUserJson(res.json(), row);
  });

  it('PATCH /users/:id accepts an uppercase-hex UUID', async () => {
    const row = await insertUser(ctx.db);

    const res = await patchUser(row.id.toUpperCase(), { name: 'Renamed' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: row.id, name: 'Renamed' });
  });

  it('DELETE /users/:id accepts an uppercase-hex UUID', async () => {
    const row = await insertUser(ctx.db);

    const res = await deleteUser(row.id.toUpperCase());

    expect(res.statusCode).toBe(204);
    expect((await findUserRow(ctx.db, row.id))?.deletedAt).toBeInstanceOf(Date);
  });

  it.each(METHODS)(
    '%s /users/:id returns 404, not 400, for an uppercase-hex UUID that matches no user',
    async (method) => {
      expectNotFound(await call(method, MISSING_ID.toUpperCase()));
    },
  );
});

describe('DELETE /users/:id', () => {
  it('returns 204 with an empty body and soft-deletes: the row stays with deletedAt set', async () => {
    const ann = await insertUser(ctx.db, {
      email: 'ann@example.com',
      name: 'Ann',
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
    });
    const bob = await insertUser(ctx.db, { email: 'bob@example.com', name: 'Bob' });

    const before = Date.now();
    const res = await deleteUser(ann.id);
    const after = Date.now();

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const row = await findUserRow(ctx.db, ann.id);
    expect(row).toMatchObject({ id: ann.id, email: 'ann@example.com', name: 'Ann' });
    expect(row?.createdAt.getTime()).toBe(LONG_AGO.getTime());
    expect(row?.deletedAt).toBeInstanceOf(Date);
    if (row?.deletedAt) expectTimestampBetween(row.deletedAt, before, after);
    expect(await findUserRow(ctx.db, bob.id)).toEqual(bob);
  });

  it('makes the user non-existent: GET, PATCH and DELETE on its id return 404 afterwards', async () => {
    const created = await createUser({ email: 'ann@example.com', name: 'Ann' });
    const id = created.json<UserJson>().id;
    expect((await deleteUser(id)).statusCode).toBe(204);
    const deletedRow = await findUserRow(ctx.db, id);

    expectNotFound(await getUser(id));
    expectNotFound(await patchUser(id, { name: 'Annie' }));
    expectNotFound(await deleteUser(id));
    expect(await findUserRow(ctx.db, id)).toEqual(deletedRow);
  });

  it('PATCH returns 404 for a user soft-deleted in the database and leaves the row untouched', async () => {
    const row = await insertUser(ctx.db, {
      name: 'Gone',
      deletedAt: LONG_AGO,
      updatedAt: LONG_AGO,
    });

    expectNotFound(await patchUser(row.id, { name: 'Back', email: 'back@example.com' }));
    expect(await findUserRow(ctx.db, row.id)).toEqual(row);
  });

  it('DELETE returns 404 for a user soft-deleted in the database and keeps the original deletedAt', async () => {
    const row = await insertUser(ctx.db, { deletedAt: LONG_AGO });

    expectNotFound(await deleteUser(row.id));
    expect(await findUserRow(ctx.db, row.id)).toEqual(row);
  });
});
