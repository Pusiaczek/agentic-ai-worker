import { describe, expect, it } from 'vitest';
import {
  allUserRows,
  emailOfLength,
  expectBadRequest,
  expectConflict,
  expectTimestampBetween,
  findUserRow,
  ISO_DATE_TIME,
  insertUser,
  insertUsers,
  LOWERCASE_UUID,
  newUserInput,
  USER_JSON_KEYS,
  type UserJson,
} from '../helpers/users.js';
import {
  createUser,
  ctx,
  deleteUser,
  getUser,
  LONG_AGO,
  NAMES_NEXT_TO_CONTROL_RANGES,
  NAMES_WITH_CONTROL_CHARACTERS,
  NON_PLAIN_EMAILS,
  PLAIN_EMAILS,
  TOO_LONG_EMAILS,
  useFreshApp,
} from '../helpers/users-routes.js';

useFreshApp();

describe('POST /users', () => {
  it('returns 201 with {id, email, name, createdAt, updatedAt} and stores the user', async () => {
    const before = Date.now();
    const res = await createUser({ email: 'ann@example.com', name: 'Ann' });
    const after = Date.now();

    expect(res.statusCode).toBe(201);
    const body = res.json<UserJson>();
    expect(Object.keys(body).sort()).toEqual(USER_JSON_KEYS);
    expect(body).not.toHaveProperty('deletedAt');
    expect(body.id).toMatch(LOWERCASE_UUID);
    expect(body.email).toBe('ann@example.com');
    expect(body.name).toBe('Ann');
    expect(body.createdAt).toMatch(ISO_DATE_TIME);
    expect(body.updatedAt).toBe(body.createdAt);
    expectTimestampBetween(body.createdAt, before, after);

    const row = await findUserRow(ctx.db, body.id);
    expect(row).toMatchObject({ email: 'ann@example.com', name: 'Ann', deletedAt: null });
  });

  it('returns and stores email and name exactly as sent (letter case, whitespace, unicode)', async () => {
    const payload = { email: 'Ann.Smith+Tag@Example.COM', name: '  Zażółć Gęślą Jaźń  ' };

    const res = await createUser(payload);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject(payload);
    const row = await findUserRow(ctx.db, res.json<UserJson>().id);
    expect(row).toMatchObject(payload);
  });

  it('returns the created user from a subsequent GET /users/:id with the same field values', async () => {
    const created = await createUser(newUserInput());
    expect(created.statusCode).toBe(201);

    const res = await getUser(created.json<UserJson>().id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created.json());
  });

  it.each([
    ['missing', { name: 'Ann' }],
    ['a number', { email: 123, name: 'Ann' }],
    ['a boolean', { email: true, name: 'Ann' }],
    ['null', { email: null, name: 'Ann' }],
    ['an array holding a valid email', { email: ['ann@example.com'], name: 'Ann' }],
    ['an object', { email: { address: 'ann@example.com' }, name: 'Ann' }],
    ['an empty string', { email: '', name: 'Ann' }],
    ["'not-an-email'", { email: 'not-an-email', name: 'Ann' }],
    ["'a@'", { email: 'a@', name: 'Ann' }],
    ["'@x.com'", { email: '@x.com', name: 'Ann' }],
    ["'a b@x.com'", { email: 'a b@x.com', name: 'Ann' }],
  ])('returns 400 and stores nothing when email is %s', async (_label, payload) => {
    const res = await createUser(payload);

    expectBadRequest(res);
    expect(await allUserRows(ctx.db)).toHaveLength(0);
  });

  it.each([
    ['missing', { email: 'ann@example.com' }],
    ['a number', { email: 'ann@example.com', name: 123 }],
    ['a boolean', { email: 'ann@example.com', name: true }],
    ['an array holding a valid name', { email: 'ann@example.com', name: ['Ann'] }],
    ['an object', { email: 'ann@example.com', name: { first: 'Ann' } }],
    ['null', { email: 'ann@example.com', name: null }],
    ['an empty string', { email: 'ann@example.com', name: '' }],
    ['101 characters long', { email: 'ann@example.com', name: 'a'.repeat(101) }],
    ['101 non-ASCII characters long', { email: 'ann@example.com', name: 'ż'.repeat(101) }],
  ])('returns 400 and stores nothing when name is %s', async (_label, payload) => {
    const res = await createUser(payload);

    expectBadRequest(res);
    expect(await allUserRows(ctx.db)).toHaveLength(0);
  });

  it.each([
    ['exactly 1 character', 'A'],
    ['exactly 100 characters', 'a'.repeat(100)],
    ['exactly 100 non-ASCII characters', 'ż'.repeat(100)],
  ])('accepts a name of %s', async (_label, name) => {
    const res = await createUser({ email: 'ann@example.com', name });

    expect(res.statusCode).toBe(201);
    expect(res.json<UserJson>().name).toBe(name);
    expect(await findUserRow(ctx.db, res.json<UserJson>().id)).toMatchObject({ name });
  });

  it('returns 400 when there is no body at all', async () => {
    const res = await createUser();

    expectBadRequest(res);
    expect(await allUserRows(ctx.db)).toHaveLength(0);
  });

  it('returns 400, not 409, when the body is invalid and the email is also taken', async () => {
    await insertUser(ctx.db, { email: 'ann@example.com' });

    const res = await createUser({ email: 'ann@example.com', name: '' });

    expectBadRequest(res);
  });

  it('ignores unknown body fields: still 201 and they are not returned', async () => {
    const res = await createUser({
      email: 'ann@example.com',
      name: 'Ann',
      role: 'admin',
      nickname: 'annie',
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<UserJson>();
    expect(Object.keys(body).sort()).toEqual(USER_JSON_KEYS);
    expect(body).toMatchObject({ email: 'ann@example.com', name: 'Ann' });
  });

  it('ignores body fields named like internal columns (id, createdAt, updatedAt, deletedAt)', async () => {
    const forgedId = '11111111-2222-4333-8444-555555555555';
    const forgedTime = '2000-01-01T00:00:00.000Z';

    const before = Date.now();
    const res = await createUser({
      email: 'ann@example.com',
      name: 'Ann',
      id: forgedId,
      createdAt: forgedTime,
      updatedAt: forgedTime,
      deletedAt: forgedTime,
    });
    const after = Date.now();

    expect(res.statusCode).toBe(201);
    const body = res.json<UserJson>();
    expect(Object.keys(body).sort()).toEqual(USER_JSON_KEYS);
    expect(body.id).not.toBe(forgedId);
    expectTimestampBetween(body.createdAt, before, after);
    expectTimestampBetween(body.updatedAt, before, after);

    expect(await findUserRow(ctx.db, forgedId)).toBeUndefined();
    const row = await findUserRow(ctx.db, body.id);
    expect(row?.deletedAt).toBeNull();
    expect((await getUser(body.id)).statusCode).toBe(200);
  });

  it('returns 409 Conflict when an active user already has the same email', async () => {
    const first = await createUser({ email: 'ann@example.com', name: 'Ann' });
    expect(first.statusCode).toBe(201);

    const res = await createUser({ email: 'ann@example.com', name: 'Another Ann' });

    expectConflict(res);
    expect(await allUserRows(ctx.db)).toHaveLength(1);
  });

  it("returns 409 Conflict when the emails differ only in letter case ('Ann@Example.com' vs 'ann@example.COM')", async () => {
    await insertUser(ctx.db, { email: 'Ann@Example.com', name: 'Ann' });

    const res = await createUser({ email: 'ann@example.COM', name: 'Another Ann' });

    expectConflict(res);
    const rows = await allUserRows(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('Ann@Example.com');
  });

  it('returns 201 when the only users with that email (in other letter cases) are soft-deleted', async () => {
    await insertUsers(ctx.db, [
      { email: 'Ann@Example.com', deletedAt: LONG_AGO },
      { email: 'ANN@EXAMPLE.COM', deletedAt: LONG_AGO },
    ]);

    const res = await createUser({ email: 'ann@example.COM', name: 'Ann' });

    expect(res.statusCode).toBe(201);
    expect(res.json<UserJson>().email).toBe('ann@example.COM');
    expect(await allUserRows(ctx.db)).toHaveLength(3);
  });

  it('allows re-creating a user with the email of a user deleted through the API', async () => {
    const first = await createUser({ email: 'ann@example.com', name: 'Ann' });
    const firstId = first.json<UserJson>().id;
    expect((await deleteUser(firstId)).statusCode).toBe(204);

    const res = await createUser({ email: 'Ann@example.com', name: 'Ann Again' });

    expect(res.statusCode).toBe(201);
    expect(res.json<UserJson>().id).not.toBe(firstId);
    expect((await getUser(res.json<UserJson>().id)).statusCode).toBe(200);
  });

  it('accepts an email of exactly 254 characters and stores it as sent', async () => {
    const email = emailOfLength(254);
    expect(email).toHaveLength(254);

    const res = await createUser({ email, name: 'Ann' });

    expect(res.statusCode).toBe(201);
    expect(res.json<UserJson>().email).toBe(email);
    expect(await findUserRow(ctx.db, res.json<UserJson>().id)).toMatchObject({ email });
  });

  it.each(TOO_LONG_EMAILS)(
    'returns 400 and stores nothing for an email of %s',
    async (_label, email) => {
      const res = await createUser({ email, name: 'Ann' });

      expectBadRequest(res);
      expect(await allUserRows(ctx.db)).toHaveLength(0);
    },
  );

  it.each(NON_PLAIN_EMAILS)(
    'returns 400 and stores nothing for an address outside the plain email format: %s',
    async (_label, email) => {
      const res = await createUser({ email, name: 'Ann' });

      expectBadRequest(res);
      expect(await allUserRows(ctx.db)).toHaveLength(0);
    },
  );

  it.each(PLAIN_EMAILS)('accepts a plain email address with %s', async (_label, email) => {
    const res = await createUser({ email, name: 'Ann' });

    expect(res.statusCode).toBe(201);
    expect(res.json<UserJson>().email).toBe(email);
  });

  it.each(NAMES_WITH_CONTROL_CHARACTERS)(
    'returns 400 and stores nothing when name contains %s',
    async (_label, name) => {
      const res = await createUser({ email: 'ann@example.com', name });

      expectBadRequest(res);
      expect(await allUserRows(ctx.db)).toHaveLength(0);
    },
  );

  it.each(NAMES_NEXT_TO_CONTROL_RANGES)(
    'accepts a name with %s and stores it as sent',
    async (_label, name) => {
      const res = await createUser({ email: 'ann@example.com', name });

      expect(res.statusCode).toBe(201);
      expect(res.json<UserJson>().name).toBe(name);
      expect(await findUserRow(ctx.db, res.json<UserJson>().id)).toMatchObject({ name });
    },
  );
});
