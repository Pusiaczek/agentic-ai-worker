import { describe, expect, it } from 'vitest';
import {
  emailOfLength,
  expectBadRequest,
  expectConflict,
  expectNotFound,
  expectTimestampBetween,
  findUserRow,
  insertUser,
  MISSING_ID,
  USER_JSON_KEYS,
  type UserJson,
} from '../helpers/users.js';
import {
  ctx,
  getUser,
  LONG_AGO,
  NAMES_NEXT_TO_CONTROL_RANGES,
  NAMES_WITH_CONTROL_CHARACTERS,
  NON_PLAIN_EMAILS,
  PLAIN_EMAILS,
  patchUser,
  TOO_LONG_EMAILS,
  useFreshApp,
} from '../helpers/users-routes.js';

useFreshApp();

describe('PATCH /users/:id', () => {
  /** An active user whose timestamps are far in the past, so a fresh updatedAt is unambiguous. */
  const seedAnn = () =>
    insertUser(ctx.db, {
      email: 'ann@example.com',
      name: 'Ann',
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
    });

  it('changes only the name; createdAt is unchanged and updatedAt is set to now', async () => {
    const ann = await seedAnn();
    const bob = await insertUser(ctx.db, { email: 'bob@example.com', name: 'Bob' });

    const before = Date.now();
    const res = await patchUser(ann.id, { name: 'Annie' });
    const after = Date.now();

    expect(res.statusCode).toBe(200);
    const body = res.json<UserJson>();
    expect(Object.keys(body).sort()).toEqual(USER_JSON_KEYS);
    expect(body).toMatchObject({ id: ann.id, email: 'ann@example.com', name: 'Annie' });
    expect(Date.parse(body.createdAt)).toBe(LONG_AGO.getTime());
    expectTimestampBetween(body.updatedAt, before, after);

    const row = await findUserRow(ctx.db, ann.id);
    expect(row).toMatchObject({ email: 'ann@example.com', name: 'Annie', deletedAt: null });
    expect(row?.createdAt.getTime()).toBe(LONG_AGO.getTime());
    expect(row?.updatedAt.getTime()).toBe(Date.parse(body.updatedAt));
    expect(await findUserRow(ctx.db, bob.id)).toEqual(bob);
    expect((await getUser(ann.id)).json()).toEqual(body);
  });

  it('changes only the email, stored exactly as sent', async () => {
    const ann = await seedAnn();

    const before = Date.now();
    const res = await patchUser(ann.id, { email: 'Ann.New@Example.org' });
    const after = Date.now();

    expect(res.statusCode).toBe(200);
    const body = res.json<UserJson>();
    expect(body).toMatchObject({ id: ann.id, email: 'Ann.New@Example.org', name: 'Ann' });
    expect(Date.parse(body.createdAt)).toBe(LONG_AGO.getTime());
    expectTimestampBetween(body.updatedAt, before, after);
    expect(await findUserRow(ctx.db, ann.id)).toMatchObject({
      email: 'Ann.New@Example.org',
      name: 'Ann',
    });
  });

  it('changes name and email together', async () => {
    const ann = await seedAnn();

    const res = await patchUser(ann.id, { email: 'annie@example.com', name: 'Annie' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ann.id, email: 'annie@example.com', name: 'Annie' });
    expect(await findUserRow(ctx.db, ann.id)).toMatchObject({
      email: 'annie@example.com',
      name: 'Annie',
    });
  });

  it('ignores unknown body fields, including ones named like internal columns', async () => {
    const ann = await seedAnn();
    const forgedTime = '2000-01-01T00:00:00.000Z';

    const res = await patchUser(ann.id, {
      name: 'Annie',
      role: 'admin',
      id: MISSING_ID,
      createdAt: forgedTime,
      deletedAt: forgedTime,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<UserJson>();
    expect(Object.keys(body).sort()).toEqual(USER_JSON_KEYS);
    expect(body.id).toBe(ann.id);
    expect(Date.parse(body.createdAt)).toBe(LONG_AGO.getTime());
    const row = await findUserRow(ctx.db, ann.id);
    expect(row).toMatchObject({ name: 'Annie', deletedAt: null });
    expect(await findUserRow(ctx.db, MISSING_ID)).toBeUndefined();
  });

  it.each([
    ['exactly 1 character', 'A'],
    ['exactly 100 characters', 'a'.repeat(100)],
  ])('accepts a new name of %s', async (_label, name) => {
    const ann = await seedAnn();

    const res = await patchUser(ann.id, { name });

    expect(res.statusCode).toBe(200);
    expect(res.json<UserJson>().name).toBe(name);
  });

  it.each([
    ['an empty object', {}],
    ['only unknown fields', { role: 'admin', nickname: 'annie' }],
    ['a JSON array', []],
    ['name: null', { name: null }],
    ['email: null', { email: null }],
    ['an empty name', { name: '' }],
    ['a 101-character name', { name: 'a'.repeat(101) }],
    ['a numeric name', { name: 123 }],
    ['a boolean name', { name: true }],
    ["email 'not-an-email'", { email: 'not-an-email' }],
    ["email 'a b@x.com'", { email: 'a b@x.com' }],
    ['a numeric email', { email: 123 }],
    ['a valid name with an invalid email', { name: 'Annie', email: 'a@' }],
    ['a valid email with a null name', { email: 'annie@example.com', name: null }],
  ])('returns 400 and changes nothing when the body is %s', async (_label, payload) => {
    const ann = await seedAnn();

    const res = await patchUser(ann.id, payload);

    expectBadRequest(res);
    expect(await findUserRow(ctx.db, ann.id)).toEqual(ann);
  });

  it('returns 400 and changes nothing when there is no body at all', async () => {
    const ann = await seedAnn();

    expectBadRequest(await patchUser(ann.id));
    expect(await findUserRow(ctx.db, ann.id)).toEqual(ann);
  });

  it('returns 400, not 404, for an invalid body even when the id matches no user', async () => {
    expectBadRequest(await patchUser(MISSING_ID, {}));
    expectBadRequest(await patchUser(MISSING_ID, { name: '' }));
  });

  it('returns 404, not 409, when the id matches no user and the email is taken', async () => {
    await insertUser(ctx.db, { email: 'bob@example.com' });

    expectNotFound(await patchUser(MISSING_ID, { email: 'bob@example.com' }));
  });

  it('returns 409 Conflict when the new email belongs to another active user (any letter case) and changes nothing', async () => {
    const ann = await seedAnn();
    const bob = await insertUser(ctx.db, { email: 'Bob@Example.com', name: 'Bob' });

    const emailOnly = await patchUser(ann.id, { email: 'bob@example.COM' });
    const withName = await patchUser(ann.id, { email: 'BOB@EXAMPLE.COM', name: 'Annie' });

    expectConflict(emailOnly);
    expectConflict(withName);
    expect(await findUserRow(ctx.db, ann.id)).toEqual(ann);
    expect(await findUserRow(ctx.db, bob.id)).toEqual(bob);
  });

  it("allows changing only the letter case of the user's own email", async () => {
    const ann = await seedAnn();

    const res = await patchUser(ann.id, { email: 'ANN@Example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.json<UserJson>().email).toBe('ANN@Example.com');
    expect((await findUserRow(ctx.db, ann.id))?.email).toBe('ANN@Example.com');
  });

  it("allows sending the user's own current email unchanged", async () => {
    const ann = await seedAnn();

    const res = await patchUser(ann.id, { email: 'ann@example.com', name: 'Annie' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'ann@example.com', name: 'Annie' });
  });

  it('allows taking the email of a soft-deleted user', async () => {
    const ann = await seedAnn();
    await insertUser(ctx.db, { email: 'Carol@Example.com', deletedAt: LONG_AGO });

    const res = await patchUser(ann.id, { email: 'carol@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.json<UserJson>().email).toBe('carol@example.com');
    expect((await findUserRow(ctx.db, ann.id))?.email).toBe('carol@example.com');
  });

  it('accepts a new email of exactly 254 characters and stores it as sent', async () => {
    const ann = await seedAnn();
    const email = emailOfLength(254);

    const res = await patchUser(ann.id, { email });

    expect(res.statusCode).toBe(200);
    expect(res.json<UserJson>().email).toBe(email);
    expect((await findUserRow(ctx.db, ann.id))?.email).toBe(email);
  });

  it.each(TOO_LONG_EMAILS)(
    'returns 400 and changes nothing for a new email of %s',
    async (_label, email) => {
      const ann = await seedAnn();

      const res = await patchUser(ann.id, { email, name: 'Annie' });

      expectBadRequest(res);
      expect(await findUserRow(ctx.db, ann.id)).toEqual(ann);
    },
  );

  it.each(NON_PLAIN_EMAILS)(
    'returns 400 and changes nothing for a new address outside the plain email format: %s',
    async (_label, email) => {
      const ann = await seedAnn();

      const res = await patchUser(ann.id, { email, name: 'Annie' });

      expectBadRequest(res);
      expect(await findUserRow(ctx.db, ann.id)).toEqual(ann);
    },
  );

  it.each(PLAIN_EMAILS)('accepts a new plain email address with %s', async (_label, email) => {
    const ann = await seedAnn();

    const res = await patchUser(ann.id, { email });

    expect(res.statusCode).toBe(200);
    expect(res.json<UserJson>().email).toBe(email);
    expect((await findUserRow(ctx.db, ann.id))?.email).toBe(email);
  });

  it.each(NAMES_WITH_CONTROL_CHARACTERS)(
    'returns 400 and changes nothing when the new name contains %s',
    async (_label, name) => {
      const ann = await seedAnn();

      const nameOnly = await patchUser(ann.id, { name });
      const withEmail = await patchUser(ann.id, { name, email: 'annie@example.com' });

      expectBadRequest(nameOnly);
      expectBadRequest(withEmail);
      expect(await findUserRow(ctx.db, ann.id)).toEqual(ann);
    },
  );

  it.each(NAMES_NEXT_TO_CONTROL_RANGES)(
    'accepts a new name with %s and stores it as sent',
    async (_label, name) => {
      const ann = await seedAnn();

      const res = await patchUser(ann.id, { name });

      expect(res.statusCode).toBe(200);
      expect(res.json<UserJson>().name).toBe(name);
      expect((await findUserRow(ctx.db, ann.id))?.name).toBe(name);
    },
  );
});
