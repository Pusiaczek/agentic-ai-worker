# test-aw

A small REST backend: Node.js 22, TypeScript, Fastify 5, Drizzle ORM on PostgreSQL.

## Setup

```sh
npm install
npm test
```

This is a pilot: the database exists only in tests, as an in-memory Postgres ([PGlite](https://pglite.dev)) created fresh for each test. No database server or Docker is needed.

`npm run dev` / `npm start` need a real Postgres at `DATABASE_URL` (see `.env.example`); none is provisioned for the pilot.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start with reload (tsx), loads `.env` |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm test` | All tests (Vitest) |
| `npx vitest run <file>` | One test file |
| `npm run typecheck` | `tsc --noEmit` over src, test and config files |
| `npm run lint` / `npm run format` | Biome check / check and fix (lint + format + import order) |
| `npm run db:generate` | Create a migration in `drizzle/` from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |

## Layout

```text
src/
  server.ts        process entry: config, DB pool, listen, graceful shutdown
  app.ts           buildApp({ db }) — Fastify instance, plugins, routes (no listen)
  config.ts        environment variables, validated
  db/schema.ts     Drizzle table definitions (source of truth for migrations)
  db/index.ts      Db type, createDb()
  db/errors.ts     Postgres error helpers (e.g. isUniqueViolation)
  routes/*.ts      one Fastify plugin per resource (health, users)
test/              mirrors src/; helpers/ has buildTestApp() and user fixtures
drizzle/           generated SQL migrations (don't edit by hand)
```

## Request validation

Every route declares TypeBox schemas for its input. `buildApp()` sets the validation for all routes, so don't pass a per-route `validatorCompiler`:

- **Bodies** are validated **without type coercion**. A number, boolean, array or `null` is never turned into a string, and `"5"` is not accepted as an integer.
- **Querystring and path params** use Fastify's default coercing Ajv: `?limit=5` becomes `5`, and `default` values are filled in.
- Pin string formats with `pattern` / `maxLength` rather than `format` when the exact rule matters (see `Email` in `src/routes/users.ts`). Write property names in `headers` schemas in lowercase: Fastify doesn't normalize them when a custom validator factory is set.

## Environment

See `.env.example`: `DATABASE_URL` (required), `HOST`, `PORT`, `LOG_LEVEL`.
