/** Example payloads printed by `aw schema <name>`. Tests parse each one, so they can't drift from the schemas. */
import type { InputSchemaName } from "./outputs";

export const EXAMPLES: Record<InputSchemaName, unknown> = {
  plan: {
    mode: "tdd",
    summary: "Add rate limiting to POST /login: max 5 failed attempts per IP per 15 minutes.",
    acceptanceCriteria: [
      "The 6th failed login from one IP within 15 minutes returns 429 with a Retry-After header.",
      "A successful login resets the counter for that IP.",
      "Attempts older than 15 minutes are not counted.",
    ],
    contract:
      "- `src/auth/rateLimiter.ts`: `createLoginRateLimiter(opts: { max: number; windowMs: number; now?: () => number })` returning `{ hit(ip: string): { allowed: boolean; retryAfterSec?: number }; reset(ip: string): void }`\n- `POST /login` responds `429 { error: \"too_many_attempts\" }` + `Retry-After` when blocked.",
    approach: [
      "Implement the limiter in src/auth/rateLimiter.ts (in-memory, injectable clock).",
      "Use it in the login handler before credential check; reset on success.",
    ],
    testStrategy: "Unit tests for the limiter with a fake clock; one integration test through the HTTP handler.",
    relevantDocs: [{ path: "docs/auth.md", why: "describes the login flow and error format" }],
    outOfScope: ["Distributed (multi-instance) rate limiting"],
    risks: ["Clock handling around the window boundary"],
  },
  tester: {
    summary: "Unit tests for the limiter (window, reset, boundary) and one HTTP test for the 429 response.",
    tests: [
      {
        file: "src/auth/rateLimiter.test.ts",
        title: "blocks the 6th failed attempt within the window",
        kind: "unit",
        covers: ["AC-1"],
        edgeCase: false,
      },
      {
        file: "src/auth/rateLimiter.test.ts",
        title: "does not count attempts exactly 15 minutes old",
        kind: "unit",
        covers: ["AC-3"],
        edgeCase: true,
        rationale: "window boundary is inclusive/exclusive ambiguity",
      },
      {
        file: "test/login.int.test.ts",
        title: "successful login resets the counter",
        kind: "integration",
        covers: ["AC-1", "AC-2"],
        edgeCase: false,
      },
    ],
    supportFiles: [],
    untestedCriteria: [],
    commandsRun: [{ command: "npx vitest run src/auth/rateLimiter.test.ts", exitCode: 1, note: "fails: module not implemented yet" }],
    openQuestions: [],
    processNotes: ["docs/auth.md does not specify the error body format for 429"],
  },
  reviewer: {
    summary: "Implementation matches the contract; one boundary bug.",
    verdict: "changes_requested",
    findings: [
      {
        file: "src/auth/rateLimiter.ts",
        line: 42,
        symbol: "createLoginRateLimiter",
        severity: "major",
        category: "edge-cases",
        message: "Attempts exactly windowMs old are still counted (`>=` should be `>`), contradicting AC-3.",
        suggestion: "Compare with `now - t < windowMs`.",
      },
      {
        file: "src/auth/login.ts",
        severity: "nit",
        category: "readability",
        message: "Magic numbers 5 and 900000 — name them.",
      },
    ],
    previousFindings: [],
    acCoverage: [
      { ac: "AC-1", verdict: "covered" },
      { ac: "AC-2", verdict: "covered" },
      { ac: "AC-3", verdict: "partial", note: "boundary bug, see finding" },
    ],
    followUps: [{ text: "Move the limiter to a shared store (Redis) before running multiple instances.", category: "maintainability" }],
    openQuestions: [],
    processNotes: [],
  },
  coder: {
    summary: "Implemented the in-memory limiter and wired it into the login handler.",
    filesChanged: [
      { path: "src/auth/rateLimiter.ts", change: "added", why: "limiter per contract" },
      { path: "src/auth/login.ts", change: "modified", why: "check limiter before credentials, reset on success" },
      { path: "docs/auth.md", change: "modified", why: "document 429 response" },
    ],
    decisions: [{ decision: "Sliding window with per-IP timestamp arrays", rationale: "simplest correct option for 5 attempts", alternatives: ["fixed window counter"] }],
    deviationsFromPlan: [],
    addressedFindings: [{ findingId: "F-1", resolution: "fixed", note: "boundary now exclusive" }],
    addressedNotes: [],
    testDisputes: [],
    testsAdded: [],
    untestedCriteria: [],
    docsUpdated: [{ path: "docs/auth.md", what: "added 429 / Retry-After to the login section" }],
    openQuestions: [],
    processNotes: [],
  },
  docs: {
    items: [
      { path: "docs/auth.md", status: "updated", note: "429 response documented by the coder" },
      { path: "README.md", status: "not_needed", note: "no setup or usage change" },
    ],
    verdict: "ok",
  },
  retro: {
    wentWell: ["Tests written first caught the window boundary bug before review."],
    wentWrong: ["Plan contract did not specify the 429 body; the tester had to guess."],
    processImprovements: ["Plan template: always specify error response shapes in the contract."],
  },
  refine: {
    summary:
      "Users module: a walking skeleton first (create and read one user end to end), then listing. The test database comes first because every item's tests need it. Editing and deleting are a later phase.",
    items: [
      {
        title: "Test database for integration tests",
        goal: "Integration tests run against a real Postgres with a clean database per test file.",
        scope: ["docker compose service for the test database", "migrations applied before the tests", "tables emptied between tests"],
        acceptanceCriteria: ["`npm test` runs the integration tests against the test database and leaves it empty afterwards."],
        suggestedMode: "light",
        modeReason: "Configuration only, no user-visible behavior.",
        touches: ["docker-compose.yml", "test/setup.ts"],
        prerequisiteFor: "Items 2 and 3 test their endpoints against the database.",
      },
      {
        title: "Create a user and read it back",
        goal: "POST /users creates a user and GET /users/:id returns it.",
        scope: ["users table and migration", "POST /users with validation", "GET /users/:id"],
        acceptanceCriteria: [
          "POST /users with a valid email and name returns 201 and the stored user.",
          "POST /users with an email already used by an active user returns 409.",
          "GET /users/:id returns 404 for an unknown id.",
        ],
        dependsOn: [1],
        suggestedMode: "tdd",
        modeReason: "New behavior with error cases.",
        touches: ["src/routes/users.ts", "src/db/schema.ts"],
      },
      {
        title: "List users with paging",
        goal: "GET /users returns users newest first, in pages.",
        scope: ["GET /users with limit and offset", "total count"],
        acceptanceCriteria: ["GET /users returns at most `limit` users, newest first, with the total count."],
        dependsOn: [2],
        suggestedMode: "tdd",
        modeReason: "New endpoint with paging rules.",
        risks: ["Stable order when two users have the same creation time."],
      },
    ],
    coverage: [
      { requirement: "Users can be created and fetched by id.", items: [2] },
      { requirement: "The list of users is paged.", items: [3] },
    ],
    outOfScope: ["Editing and deleting users: the slice text mentions them only as a later phase."],
    openQuestions: ["Should the list include soft-deleted users for admins?"],
  },
};
