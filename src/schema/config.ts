/** Per-repository configuration: .claude/aw.config.json. Every field has a default. */
import { z } from "zod";
import { Mode } from "./status";

export const CONFIG_FILE = ".claude/aw.config.json";

export const DEFAULT_TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/__fixtures__/**",
  "test/**",
  "tests/**",
  "e2e/**",
];

/** Command prefixes the aw subagents may never run. The user's own session is not affected. */
export const DEFAULT_BASH_DENY = [
  "git push",
  "git commit",
  "git reset",
  "git clean",
  "git checkout",
  "git switch",
  "git restore",
  "git stash",
  "git rebase",
  "git merge",
  "npm publish",
];

/**
 * Test-runner invocations aw agents may not run directly (guards.directTestCommands = "block"):
 * they use `aw test`, and the full suite runs once as a gate at submit. Commands under `commands`
 * whose key starts with "test" (or is "e2e") are added on top of these.
 */
export const DEFAULT_TEST_COMMANDS = [
  "npm test",
  "npm t",
  "npm run test",
  "pnpm test",
  "pnpm run test",
  "pnpm vitest",
  "pnpm exec vitest",
  "pnpm jest",
  "yarn test",
  "yarn run test",
  "yarn vitest",
  "yarn jest",
  "bun test",
  "bunx vitest",
  "npx vitest",
  "vitest",
  "npx jest",
  "jest",
  "npx mocha",
  "mocha",
  "node --test",
  "npx playwright test",
  "npx ava",
];

/** What aw agents may do with test runners: only `aw test` ("block"), or anything ("allow"). */
export const DirectTestCommands = z.enum(["block", "allow"]);
export type DirectTestCommands = z.infer<typeof DirectTestCommands>;

/** Read-only command prefixes for the reviewer. Commands from `commands` are allowed on top of these. */
export const DEFAULT_REVIEWER_BASH = [
  "git diff",
  "git log",
  "git show",
  "git status",
  "git blame",
  "git ls-files",
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "wc",
  "tree",
  "pwd",
  "echo",
];

const Gate = z
  .object({
    run: z.string().min(1).describe("Key in `commands`. `{files}` in that command is replaced with the relevant test files."),
    expect: z.enum(["pass", "fail"]).default("pass"),
    onMismatch: z.enum(["reject", "warn"]).default("reject").describe("reject = submit is refused; warn = recorded for the reviewer."),
  })
  .strict();
export type Gate = z.infer<typeof Gate>;

const ResumePolicy = z.enum(["always", "never", "on-dispute"]);

const agentPolicy = (resume: z.infer<typeof ResumePolicy>, bashAllow: string[]) =>
  z
    .object({
      resume: ResumePolicy.default(resume).describe("Whether the next run of this role continues the previous agent's context."),
      bashAllow: z
        .array(z.string())
        .default(bashAllow)
        .describe('Allowed command prefixes. ["*"] = anything not in guards.bashDeny.'),
    })
    .strict()
    .prefault({});

export const Config = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    language: z.string().default("en").describe("Language for free-text fields agents write and for report.md."),
    paths: z
      .object({
        tasksDir: z.string().default(".tasks"),
        archiveDir: z.string().default(".tasks/archive"),
        roleNotesDir: z.string().default(".claude/aw"),
      })
      .strict()
      .prefault({}),
    commands: z
      .record(z.string(), z.string())
      .default({})
      .describe('Named shell commands, e.g. { "test": "npm test", "testFiles": "npx vitest run {files}" }.'),
    tests: z
      .object({ globs: z.array(z.string()).min(1).default(DEFAULT_TEST_GLOBS) })
      .strict()
      .prefault({}),
    docs: z
      .array(z.object({ path: z.string(), when: z.string() }).strict())
      .default([])
      .describe("Documentation index: which doc to read/update and when."),
    flow: z
      .object({
        defaultMode: Mode.default("tdd"),
        requireApproval: z
          .object({ tdd: z.boolean().default(true), light: z.boolean().default(false) })
          .strict()
          .prefault({}),
        docsCheck: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    gates: z
      .object({ afterTests: z.array(Gate).default([]), afterCoding: z.array(Gate).default([]) })
      .strict()
      .prefault({}),
    limits: z
      .object({
        maxTestIterations: z.number().int().positive().default(3),
        maxCodeIterations: z.number().int().positive().default(3),
        maxSubmitAttempts: z.number().int().positive().default(5),
        gateTimeoutSec: z.number().int().positive().default(900),
        finalMessageMaxChars: z.number().int().positive().default(600),
        stopBlocks: z.number().int().nonnegative().default(2),
      })
      .strict()
      .prefault({}),
    refine: z
      .object({
        maxCriteriaPerItem: z
          .number()
          .int()
          .positive()
          .default(8)
          .describe("Most acceptance criteria one item of a refinement may have; a bigger item must be split."),
        maxItems: z.number().int().positive().default(15).describe("Most items one refinement may have; a bigger slice must be split."),
      })
      .strict()
      .prefault({}),
    agents: z
      .object({
        coder: agentPolicy("always", ["*"]),
        tester: agentPolicy("on-dispute", ["*"]),
        reviewer: agentPolicy("never", DEFAULT_REVIEWER_BASH),
      })
      .strict()
      .prefault({}),
    guards: z
      .object({
        bashDeny: z.array(z.string()).default(DEFAULT_BASH_DENY),
        blockMainSessionEditsDuringRuns: z.boolean().default(true),
        directTestCommands: DirectTestCommands.default("block")
          .describe('"block": aw agents run tests only through `aw test`; the full suite runs once as a gate at submit.'),
        testCommandPrefixes: z.array(z.string()).default(DEFAULT_TEST_COMMANDS),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const phase of ["afterTests", "afterCoding"] as const) {
      cfg.gates[phase].forEach((gate, i) => {
        if (!(gate.run in cfg.commands)) {
          ctx.addIssue({
            code: "custom",
            path: ["gates", phase, i, "run"],
            message: `"${gate.run}" is not defined in commands`,
          });
        }
      });
    }
  });
export type Config = z.infer<typeof Config>;
