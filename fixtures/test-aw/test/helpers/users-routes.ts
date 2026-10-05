/**
 * Shared harness of the users route tests. The test-aw pilot had them in one file
 * (test/routes/users.test.ts); the fixture splits it per endpoint group so vitest can spread the
 * files over workers. Each test file calls `useFreshApp()` once at the top.
 */
import { afterEach, beforeEach } from 'vitest';
import type { User } from '../../src/db/schema.js';
import { buildTestApp, type TestContext } from './app.js';
import { emailOfLength, hugeEmail, insertUsers, seedId } from './users.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** The current test's app, database and client; set before each test by `useFreshApp()`. */
export let ctx: TestContext;

/**
 * Registers the hooks that give every test its own app on a clean database, and close them
 * afterwards. `ownDatabase`: see `buildTestApp`.
 */
export function useFreshApp({ ownDatabase = false } = {}) {
  beforeEach(async () => {
    ctx = await buildTestApp({ ownDatabase });
  });

  afterEach(async () => {
    await ctx.app.close();
  });
}

export function send(method: Method, url: string, payload?: object | string) {
  return ctx.app.inject({ method, url, payload });
}

export const createUser = (payload?: object) => send('POST', '/users', payload);
export const getUser = (id: string) => send('GET', `/users/${id}`);
export const patchUser = (id: string, payload?: object) => send('PATCH', `/users/${id}`, payload);
export const deleteUser = (id: string) => send('DELETE', `/users/${id}`);
export const listUsers = (query = '') => send('GET', `/users${query}`);

/** Fixed timestamps for seeded rows, so no assertion depends on how fast the test runs. */
export const T0 = Date.parse('2025-01-01T00:00:00.000Z');
export const minutesAfterT0 = (n: number) => new Date(T0 + n * 60_000);
export const LONG_AGO = new Date('2024-01-01T00:00:00.000Z');

/**
 * Seeds `count` active users; user i is created i minutes after T0 (user 0 is the oldest).
 * Ids, emails, updatedAt and insertion order are deliberately unrelated to createdAt order, so
 * only a real `created_at DESC` sort produces the expected order:
 * - ids rank as a reversed rotation and updatedAt/emails as a rotation of createdAt, each shifted
 *   by count/2, so sorting by any of them (ascending or descending) puts a different user than
 *   `created_at DESC` at every page position of two or more items;
 * - for count >= 5 neither the newest nor the oldest user has the smallest or largest id, email
 *   or updatedAt, so single-item pages (limit=1, the last offset) can't match by accident either.
 * Every updatedAt is later than every createdAt. Returns the rows newest first.
 */
export async function seedTimeline(count: number): Promise<User[]> {
  const shift = Math.floor(count / 2);
  const idRank = (i: number) => (count - 1 - i + shift) % count;
  const updatedRank = (i: number) => (i + shift) % count;
  const values = Array.from({ length: count }, (_, i) => ({
    id: seedId(idRank(i) + 1),
    email: `timeline${String(updatedRank(i)).padStart(3, '0')}@example.com`,
    name: `Timeline ${i}`,
    createdAt: minutesAfterT0(i),
    updatedAt: minutesAfterT0(count + updatedRank(i)),
  }));
  const insertionOrder = [
    ...values.filter((_, i) => i % 2 === 1),
    ...values.filter((_, i) => i % 2 === 0).reverse(),
  ];
  const rows = await insertUsers(ctx.db, insertionOrder);
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export const ids = (items: { id: string }[]) => items.map((item) => item.id);

/** Emails longer than the 254-character limit, but otherwise in the plain email format. */
export const TOO_LONG_EMAILS: [label: string, email: string][] = [
  ['255 characters', emailOfLength(255)],
  ['about 3000 non-repetitive characters', hugeEmail(3000)],
];

/**
 * Addresses outside the plain email format (the ajv-formats "full" regex). The first three are
 * valid under RFC 5322, the rest are malformed variants the pinned regex rejects.
 */
export const NON_PLAIN_EMAILS: [label: string, email: string][] = [
  ["no dot in the domain ('ann@localhost')", 'ann@localhost'],
  ['a quoted local part (\'"a b"@x.com\')', '"a b"@x.com'],
  ["an IP-literal domain ('a@[127.0.0.1]')", 'a@[127.0.0.1]'],
  ['an IPv6-literal domain', 'a@[IPv6:2001:db8::1]'],
  ['a quoted local part without spaces', '"ann"@example.com'],
  ['a single-label domain', 'ann@example'],
  ['two dots in a row in the local part', 'ann..smith@example.com'],
  ['a leading dot in the local part', '.ann@example.com'],
  ['a trailing dot in the local part', 'ann.@example.com'],
  ['a domain label starting with a hyphen', 'ann@-example.com'],
  ['a domain label ending with a hyphen', 'ann@example-.com'],
  ['an empty domain label', 'ann@example..com'],
  ['a trailing dot after the domain', 'ann@example.com.'],
  ['a non-ASCII local part', 'żółw@example.com'],
  ['a non-ASCII domain', 'ann@exämple.com'],
  ['two @ signs', 'ann@smith@example.com'],
  ['a leading space', ' ann@example.com'],
  ['a trailing space', 'ann@example.com '],
  ['a trailing line feed', 'ann@example.com\n'],
];

/** Addresses the plain email format accepts (letter case is covered elsewhere). */
export const PLAIN_EMAILS: [label: string, email: string][] = [
  ['a dotted local part and a multi-label domain', 'first.last@mail.example.co.uk'],
  ["an apostrophe and a plus tag ('o'brien+tag')", "o'brien+tag@example.com"],
  ['an underscore, hyphens and a hyphenated domain', 'x_y-z@a-b.io'],
  ['every special character the format allows', "a!#$%&'*+/=?^_`{|}~-z@example.com"],
];

/** Names with a control character (U+0000–U+001F or U+007F). */
export const NAMES_WITH_CONTROL_CHARACTERS: [label: string, name: string][] = [
  ['only U+0000 (NUL)', '\u0000'],
  ['U+0000 (NUL) inside', 'Ann\u0000Smith'],
  ['a line feed', 'Ann\nSmith'],
  ['a tab', 'Ann\tSmith'],
  ['a carriage return', 'Ann\rSmith'],
  ['U+0001 at the start', '\u0001Ann'],
  ['U+001F (the last C0 control) at the end', 'Ann\u001f'],
  ['U+007F (DEL)', 'Ann\u007fSmith'],
  ['a line feed in an otherwise 100-character name', `${'a'.repeat(50)}\n${'a'.repeat(49)}`],
];

/** Names with characters right next to the forbidden ranges, which are allowed. */
export const NAMES_NEXT_TO_CONTROL_RANGES: [label: string, name: string][] = [
  ['a space (U+0020) and a tilde (U+007E)', 'Ann ~Smith~'],
  ['a no-break space (U+00A0)', 'Ann Smith'],
];
