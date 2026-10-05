import { describe, expect, it } from 'vitest';
import {
  expectBadRequest,
  expectUserJson,
  insertUsers,
  seedId,
  USER_JSON_KEYS,
  type UserListJson,
} from '../helpers/users.js';
import {
  ctx,
  deleteUser,
  ids,
  LONG_AGO,
  listUsers,
  minutesAfterT0,
  patchUser,
  seedTimeline,
  useFreshApp,
} from '../helpers/users-routes.js';

useFreshApp();

describe('GET /users', () => {
  it('returns 200 {items: [], total: 0, limit: 20, offset: 0} when there are no users', async () => {
    const res = await listUsers();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it('defaults to limit 20 and offset 0: returns the 20 newest of 25 users with the public fields', async () => {
    const rows = await seedTimeline(25);

    const res = await listUsers();

    expect(res.statusCode).toBe(200);
    const body = res.json<UserListJson>();
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'offset', 'total']);
    expect(body.total).toBe(25);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
    expect(ids(body.items)).toEqual(ids(rows.slice(0, 20)));
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(USER_JSON_KEYS);
    }
    const [newestRow] = rows;
    if (!newestRow) throw new Error('seedTimeline returned no rows');
    expectUserJson(body.items[0], newestRow);
  });

  it('orders items by createdAt descending (not by id, email, updatedAt or insertion order)', async () => {
    // Expected order: u3, u2, u1, u0. Sorting by id, email or updatedAt (ascending or
    // descending) or keeping insertion order gives a different order, and a different first user.
    const u0 = {
      id: seedId(3),
      email: 'b@example.com',
      createdAt: minutesAfterT0(0),
      updatedAt: minutesAfterT0(7),
    };
    const u1 = {
      id: seedId(1),
      email: 'd@example.com',
      createdAt: minutesAfterT0(1),
      updatedAt: minutesAfterT0(9),
    };
    const u2 = {
      id: seedId(4),
      email: 'a@example.com',
      createdAt: minutesAfterT0(2),
      updatedAt: minutesAfterT0(6),
    };
    const u3 = {
      id: seedId(2),
      email: 'c@example.com',
      createdAt: minutesAfterT0(3),
      updatedAt: minutesAfterT0(8),
    };
    await insertUsers(ctx.db, [u1, u3, u0, u2]);

    const res = await listUsers();

    expect(res.statusCode).toBe(200);
    expect(ids(res.json<UserListJson>().items)).toEqual([u3.id, u2.id, u1.id, u0.id]);
  });

  it('orders users with equal createdAt by id descending', async () => {
    const tie = minutesAfterT0(10);
    const tiedA = {
      id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      email: 'z@example.com',
      createdAt: tie,
    };
    const tied1 = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'y@example.com',
      createdAt: tie,
    };
    const tiedF = {
      id: 'ffffffff-ffff-4fff-bfff-fffffffffff0',
      email: 'x@example.com',
      createdAt: tie,
    };
    const tiedC = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      email: 'w@example.com',
      createdAt: tie,
    };
    const newer = { id: seedId(1), createdAt: minutesAfterT0(11) };
    const older = { id: 'ffffffff-ffff-4fff-bfff-ffffffffffff', createdAt: minutesAfterT0(9) };
    await insertUsers(ctx.db, [tiedA, older, tied1, tiedF, newer, tiedC]);

    const res = await listUsers();

    expect(res.statusCode).toBe(200);
    expect(ids(res.json<UserListJson>().items)).toEqual([
      newer.id,
      tiedF.id,
      tiedC.id,
      tiedA.id,
      tied1.id,
      older.id,
    ]);
  });

  it('keeps an updated user at its createdAt position (a PATCH does not move it up)', async () => {
    const [oldest, middle, newest] = await insertUsers(ctx.db, [
      { id: seedId(3), createdAt: minutesAfterT0(1), updatedAt: minutesAfterT0(1) },
      { id: seedId(1), createdAt: minutesAfterT0(2), updatedAt: minutesAfterT0(2) },
      { id: seedId(2), createdAt: minutesAfterT0(3), updatedAt: minutesAfterT0(3) },
    ]);
    if (!oldest || !middle || !newest) throw new Error('seed failed');
    expect((await patchUser(oldest.id, { name: 'Renamed Oldest' })).statusCode).toBe(200);

    const res = await listUsers();

    expect(res.statusCode).toBe(200);
    expect(ids(res.json<UserListJson>().items)).toEqual([newest.id, middle.id, oldest.id]);
  });

  it('pages through users with tied createdAt without duplicates or gaps', async () => {
    const tie = minutesAfterT0(10);
    await insertUsers(
      ctx.db,
      [7, 2, 9, 4, 1, 8, 3].map((n) => ({ id: seedId(n), createdAt: tie })),
    );

    const pages = await Promise.all(
      [0, 2, 4, 6].map((offset) => listUsers(`?limit=2&offset=${offset}`)),
    );

    const paged = pages.flatMap((page) => ids(page.json<UserListJson>().items));
    expect(paged).toEqual([9, 8, 7, 4, 3, 2, 1].map(seedId));
  });

  it('pages with limit and offset: with 25 users, limit=10&offset=20 returns the 5 oldest', async () => {
    const rows = await seedTimeline(25);

    const res = await listUsers('?limit=10&offset=20');

    expect(res.statusCode).toBe(200);
    const body = res.json<UserListJson>();
    expect(body).toMatchObject({ total: 25, limit: 10, offset: 20 });
    expect(ids(body.items)).toEqual(ids(rows.slice(20, 25)));
  });

  it('returns consecutive pages for offset=0 and offset=10 with the same total', async () => {
    const rows = await seedTimeline(25);

    const first = (await listUsers('?limit=10&offset=0')).json<UserListJson>();
    const second = (await listUsers('?limit=10&offset=10')).json<UserListJson>();

    expect(first).toMatchObject({ total: 25, limit: 10, offset: 0 });
    expect(ids(first.items)).toEqual(ids(rows.slice(0, 10)));
    expect(second).toMatchObject({ total: 25, limit: 10, offset: 10 });
    expect(ids(second.items)).toEqual(ids(rows.slice(10, 20)));
  });

  it('returns only the oldest user at the last offset, and an empty page past the end', async () => {
    const rows = await seedTimeline(25);

    const last = await listUsers('?offset=24');
    const atEnd = await listUsers('?offset=25');
    const farPastEnd = await listUsers('?limit=5&offset=1000');

    expect(last.statusCode).toBe(200);
    expect(ids(last.json<UserListJson>().items)).toEqual(ids(rows.slice(24)));
    expect(atEnd.statusCode).toBe(200);
    expect(atEnd.json()).toEqual({ items: [], total: 25, limit: 20, offset: 25 });
    expect(farPastEnd.statusCode).toBe(200);
    expect(farPastEnd.json()).toEqual({ items: [], total: 25, limit: 5, offset: 1000 });
  });

  it('accepts limit=1 and returns only the newest user', async () => {
    const rows = await seedTimeline(5);

    const res = await listUsers('?limit=1');

    expect(res.statusCode).toBe(200);
    const body = res.json<UserListJson>();
    expect(body).toMatchObject({ total: 5, limit: 1, offset: 0 });
    expect(ids(body.items)).toEqual(ids(rows.slice(0, 1)));
  });

  it('accepts limit=100 and returns the 100 newest of 101 users', async () => {
    const rows = await seedTimeline(101);

    const res = await listUsers('?limit=100');

    expect(res.statusCode).toBe(200);
    const body = res.json<UserListJson>();
    expect(body).toMatchObject({ total: 101, limit: 100, offset: 0 });
    expect(ids(body.items)).toEqual(ids(rows.slice(0, 100)));
  });

  it('accepts the maximum offset 9007199254740991 and returns an empty page', async () => {
    await seedTimeline(2);

    const res = await listUsers('?offset=9007199254740991');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 2, limit: 20, offset: 9007199254740991 });
  });

  it.each([
    'limit=0',
    'limit=-1',
    'limit=101',
    'offset=-1',
    'offset=9007199254740992',
    'limit=abc',
    'offset=abc',
    'limit=1.5',
    'offset=1.5',
  ])('returns 400 for ?%s', async (query) => {
    await seedTimeline(2);

    expectBadRequest(await listUsers(`?${query}`));
  });

  it('excludes soft-deleted users from items and from total', async () => {
    // The deleted users are the newest, so they would come first if they were not filtered out.
    const active = await insertUsers(ctx.db, [
      { createdAt: minutesAfterT0(1) },
      { createdAt: minutesAfterT0(2) },
      { createdAt: minutesAfterT0(3) },
    ]);
    await insertUsers(ctx.db, [
      { createdAt: minutesAfterT0(4), deletedAt: minutesAfterT0(5) },
      { createdAt: minutesAfterT0(6), deletedAt: minutesAfterT0(7) },
    ]);

    const res = await listUsers();

    expect(res.statusCode).toBe(200);
    const body = res.json<UserListJson>();
    expect(body.total).toBe(3);
    expect(ids(body.items)).toEqual(ids([...active].reverse()));
  });

  it('does not let users deleted through the API take up page slots or count in total', async () => {
    const rows = await seedTimeline(5);
    const [newest, second, third, fourth, oldest] = rows;
    if (!newest || !second || !third || !fourth || !oldest) throw new Error('seed failed');
    expect((await deleteUser(newest.id)).statusCode).toBe(204);
    expect((await deleteUser(third.id)).statusCode).toBe(204);

    const firstPage = (await listUsers('?limit=2&offset=0')).json<UserListJson>();
    const secondPage = (await listUsers('?limit=2&offset=2')).json<UserListJson>();

    expect(firstPage.total).toBe(3);
    expect(ids(firstPage.items)).toEqual([second.id, fourth.id]);
    expect(secondPage.total).toBe(3);
    expect(ids(secondPage.items)).toEqual([oldest.id]);
  });

  it('returns an empty page with total 0 when every user is soft-deleted', async () => {
    await insertUsers(ctx.db, [{ deletedAt: LONG_AGO }, { deletedAt: LONG_AGO }]);

    const res = await listUsers();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });
});
