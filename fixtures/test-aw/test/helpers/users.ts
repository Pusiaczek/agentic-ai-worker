import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { type NewUser, type User, users } from '../../src/db/schema.js';
import type { TestContext } from './app.js';

type Db = TestContext['db'];

/** A user as the API returns it. */
export interface UserJson {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** The body of GET /users. */
export interface UserListJson {
  items: UserJson[];
  total: number;
  limit: number;
  offset: number;
}

/** The only keys a user in a response may have (never deletedAt). */
export const USER_JSON_KEYS = ['createdAt', 'email', 'id', 'name', 'updatedAt'];

export const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A well-formed UUID that no test ever inserts. */
export const MISSING_ID = '3f1c2b4a-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

export const NOT_FOUND_BODY = { statusCode: 404, error: 'Not Found', message: 'User not found' };
export const CONFLICT_BODY = {
  statusCode: 409,
  error: 'Conflict',
  message: 'Email already in use',
};

/** How far a server-side "now" may be from the test's own clock readings around a request. */
const CLOCK_SLACK_MS = 5_000;

let counter = 0;

/** A valid POST /users body with an email that is unique within the test run. */
export function newUserInput(overrides: Partial<{ email: string; name: string }> = {}) {
  counter += 1;
  return { email: `user${counter}@example.com`, name: `User ${counter}`, ...overrides };
}

/**
 * An otherwise valid email address of exactly `length` characters (198–260): a 64-character local
 * part and domain labels of at most 63 characters, so nothing but the total length can make it
 * invalid. `emailOfLength(254)` is the longest address the API accepts.
 */
export function emailOfLength(length: number): string {
  const fixed = 64 + 1 + 63 + 1 + 63 + 1 + '.com'.length;
  const lastLabel = length - fixed;
  if (lastLabel < 1 || lastLabel > 63) throw new Error(`emailOfLength: unsupported ${length}`);
  return `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(lastLabel)}.com`;
}

/**
 * A `length`-character address in the plain email format whose local part is pseudo-random
 * (fixed seed, so deterministic) dot-separated alphanumerics. Being non-repetitive, Postgres can't
 * compress it below the btree limit of the lower(email) index: if validation let it through, the
 * INSERT/UPDATE would fail in the database instead of returning 400.
 */
export function hugeEmail(length = 3000): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const domain = '@example.com';
  let seed = 20260928;
  let local = '';
  while (local.length < length - domain.length) {
    const atSegmentEnd = local.length % 61 === 60 && local.length < length - domain.length - 1;
    if (atSegmentEnd) {
      local += '.';
    } else {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      local += alphabet[(seed >>> 16) % alphabet.length];
    }
  }
  return `${local}${domain}`;
}

/** Deterministic lowercase UUID for seeding: 00000000-0000-4000-8000-<n as 12 hex digits>. */
export function seedId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/**
 * Inserts user rows directly (bypassing the API), e.g. with explicit ids, timestamps or
 * deletedAt. Missing email/name get unique defaults. Returns the rows in insertion order.
 */
export async function insertUsers(db: Db, values: Partial<NewUser>[]): Promise<User[]> {
  return db
    .insert(users)
    .values(values.map((v) => ({ ...newUserInput(), ...v })))
    .returning();
}

export async function insertUser(db: Db, values: Partial<NewUser> = {}): Promise<User> {
  const [row] = await insertUsers(db, [values]);
  if (!row) throw new Error('insertUser: no row returned');
  return row;
}

/** The raw row (including deletedAt), or undefined if there is none. */
export async function findUserRow(db: Db, id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}

export async function allUserRows(db: Db): Promise<User[]> {
  return db.select().from(users);
}

/** Asserts the response is a Fastify validation error. The message text is not part of the contract. */
export function expectBadRequest(res: LightMyRequestResponse) {
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
}

export function expectNotFound(res: LightMyRequestResponse) {
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual(NOT_FOUND_BODY);
}

export function expectConflict(res: LightMyRequestResponse) {
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual(CONFLICT_BODY);
}

/** Asserts an unexpected server error (500), e.g. a database failure that is not an email conflict. */
export function expectServerError(res: LightMyRequestResponse) {
  expect(res.statusCode).toBe(500);
  expect(res.json()).toMatchObject({ statusCode: 500 });
}

/** Asserts `json` is exactly the public representation of `row`. */
export function expectUserJson(json: unknown, row: User) {
  expect(json).toEqual({
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: expect.stringMatching(ISO_DATE_TIME),
    updatedAt: expect.stringMatching(ISO_DATE_TIME),
  });
  const user = json as UserJson;
  expect(Date.parse(user.createdAt)).toBe(row.createdAt.getTime());
  expect(Date.parse(user.updatedAt)).toBe(row.updatedAt.getTime());
}

/** Asserts a timestamp was taken between two `Date.now()` readings (with some clock slack). */
export function expectTimestampBetween(value: string | Date, from: number, to: number) {
  const time = typeof value === 'string' ? Date.parse(value) : value.getTime();
  expect(time).toBeGreaterThanOrEqual(from - CLOCK_SLACK_MS);
  expect(time).toBeLessThanOrEqual(to + CLOCK_SLACK_MS);
}
