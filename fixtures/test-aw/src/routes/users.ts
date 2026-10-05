import { type FastifyPluginAsyncTypebox, type Static, Type } from '@fastify/type-provider-typebox';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { isUniqueViolation } from '../db/errors.js';
import { USERS_EMAIL_ACTIVE_UNIQUE, type User, users } from '../db/schema.js';

// Canonical 8-4-4-4-12 hex form. Not `format: 'uuid'`: Ajv's uuid format also accepts a
// `urn:uuid:` prefix, which Postgres rejects (that would be a 500 instead of a 400).
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const UserParams = Type.Object({ id: Type.String({ pattern: UUID_PATTERN }) });

// A plain address: the ajv-formats "full" email regex (what Fastify's Ajv checks for
// `format: 'email'`), with A-Z spelled out because a JSON Schema pattern has no `i` flag. The
// domain needs a dot, and quoted local parts and IP literals are rejected. Pinned as a pattern so
// it doesn't depend on a validator's built-in formats.
const EMAIL_ATOM = "[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+";
const EMAIL_LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
const EMAIL_PATTERN = `^${EMAIL_ATOM}(?:\\.${EMAIL_ATOM})*@(?:${EMAIL_LABEL}\\.)+${EMAIL_LABEL}$`;

// 254 is the longest address SMTP allows (RFC 5321). It also keeps lower(email) far below the
// btree tuple limit of users_email_active_unique, which would otherwise make a long email a 500.
const Email = Type.String({ maxLength: 254, pattern: EMAIL_PATTERN });
// No control characters (U+0000–U+001F, U+007F). Postgres can't store U+0000 at all.
const Name = Type.String({ minLength: 1, maxLength: 100, pattern: '^[^\\u0000-\\u001F\\u007F]*$' });

// Unknown body fields are allowed; handlers only ever read email and name.
const CreateUserBody = Type.Object({ email: Email, name: Name });
const UpdateUserBody = Type.Object(
  { email: Type.Optional(Email), name: Type.Optional(Name) },
  { anyOf: [{ required: ['email'] }, { required: ['name'] }] },
);

// Querystrings keep Fastify's coercing Ajv (see buildApp): it converts '20' to 20 (rejecting
// '1.5' and 'abc') and fills in the defaults, so both values are always present in the handler.
const ListUsersQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
  offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }),
});

const UserResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String(),
  name: Type.String(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

const UserListResponse = Type.Object({
  items: Type.Array(UserResponse),
  total: Type.Integer(),
  limit: Type.Integer(),
  offset: Type.Integer(),
});

const ErrorResponse = Type.Object({
  statusCode: Type.Integer(),
  code: Type.Optional(Type.String()),
  error: Type.String(),
  message: Type.String(),
});

const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'User not found' } as const;
const EMAIL_CONFLICT = {
  statusCode: 409,
  error: 'Conflict',
  message: 'Email already in use',
} as const;

/** Only active users (not soft-deleted) exist as far as the API is concerned. */
const isActive = isNull(users.deletedAt);

function toUserJson(user: User): Static<typeof UserResponse> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export const usersRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/',
    {
      schema: {
        body: CreateUserBody,
        response: { 201: UserResponse, 400: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { email, name } = request.body;
      let created: User | undefined;
      try {
        [created] = await app.db.insert(users).values({ email, name }).returning();
      } catch (err) {
        if (isUniqueViolation(err, USERS_EMAIL_ACTIVE_UNIQUE)) {
          return reply.code(409).send(EMAIL_CONFLICT);
        }
        throw err;
      }
      if (!created) throw new Error('insert into users returned no row');
      return reply.code(201).send(toUserJson(created));
    },
  );

  app.get(
    '/',
    {
      schema: {
        querystring: ListUsersQuery,
        response: { 200: UserListResponse, 400: ErrorResponse },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const [rows, total] = await Promise.all([
        app.db
          .select()
          .from(users)
          .where(isActive)
          .orderBy(desc(users.createdAt), desc(users.id))
          .limit(limit)
          .offset(offset),
        app.db.$count(users, isActive),
      ]);
      return { items: rows.map(toUserJson), total, limit, offset };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        params: UserParams,
        response: { 200: UserResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const [user] = await app.db
        .select()
        .from(users)
        .where(and(eq(users.id, request.params.id), isActive));
      if (!user) return reply.code(404).send(NOT_FOUND);
      return toUserJson(user);
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        params: UserParams,
        body: UpdateUserBody,
        response: { 200: UserResponse, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { email, name } = request.body;
      let updated: User | undefined;
      try {
        // A single UPDATE: a missing or soft-deleted user matches no row, so it is a 404 without
        // a separate read. Undefined fields are left out of the SET list by Drizzle.
        [updated] = await app.db
          .update(users)
          .set({ email, name, updatedAt: sql`now()` })
          .where(and(eq(users.id, request.params.id), isActive))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, USERS_EMAIL_ACTIVE_UNIQUE)) {
          return reply.code(409).send(EMAIL_CONFLICT);
        }
        throw err;
      }
      if (!updated) return reply.code(404).send(NOT_FOUND);
      return toUserJson(updated);
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        params: UserParams,
        response: { 204: Type.Null(), 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const [deleted] = await app.db
        .update(users)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(users.id, request.params.id), isActive))
        .returning({ id: users.id });
      if (!deleted) return reply.code(404).send(NOT_FOUND);
      return reply.code(204).send(null);
    },
  );
};
