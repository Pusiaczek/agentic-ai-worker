import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";
import type { z } from "zod";
import { run } from "../src/main";
import type { RefineOutput } from "../src/schema/outputs";
import type { RefinementState } from "../src/schema/refinement";
import type { Run, TaskState } from "../src/schema/state";
import type { Role } from "../src/schema/status";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

export interface Result {
  code: number;
  out: string;
  err: string;
}

export function cli(cwd: string, args: string[], stdin = ""): Result {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, {
    cwd,
    env: process.env,
    readStdin: () => stdin,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// ---------------------------------------------------------------- hooks

/** What `aw hook <event>` printed — the JSON Claude Code would receive. */
export interface HookResponse {
  hookSpecificOutput?: {
    hookEventName: string;
    /** PreToolUse: block the tool call, or force a confirmation prompt for the user. */
    permissionDecision?: "deny" | "ask";
    permissionDecisionReason?: string;
    /** Text added to the model's context (SubagentStart, PostToolUse). */
    additionalContext?: string;
  };
  /** SubagentStop: keep the agent running, with `reason` as its next instruction. */
  decision?: "block";
  reason?: string;
}

/** Run a hook the way Claude Code does. null = the hook printed nothing, i.e. it let the action through. */
export function hook(cwd: string, event: string, input: Record<string, unknown>): HookResponse | null {
  const result = cli(cwd, ["hook", event], JSON.stringify({ cwd, ...input }));
  return result.out ? (JSON.parse(result.out) as HookResponse) : null;
}

/** The PreToolUse verdict: "deny", "ask", or null when the tool call may proceed. */
export const permissionDecision = (response: HookResponse | null) => response?.hookSpecificOutput?.permissionDecision ?? null;

export const additionalContext = (response: HookResponse | null) => response?.hookSpecificOutput?.additionalContext;

/** Hook input for a Bash call made by `agentType` (e.g. "aw:coder"); without it, by the main session. */
export const bashCall = (command: string, agentType?: string) => ({
  tool_name: "Bash",
  tool_input: { command },
  ...(agentType ? { agent_type: agentType } : {}),
});

/** Hook input for an Edit of `filePath` made by `agentType`; without it, by the main session. */
export const editCall = (filePath: string, agentType?: string) => ({
  tool_name: "Edit",
  tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
  ...(agentType ? { agent_type: agentType } : {}),
});

export function write(dir: string, file: string, content: unknown): void {
  const abs = path.join(dir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

/** Read a JSON file; the caller states what it expects to find. */
export function readJson<T>(dir: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as T;
}

export function tmpDir(prefix = "aw-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * A tiny project whose "test suite" passes only once src/impl.js exists —
 * enough to exercise the TDD red check and the coder's gates.
 */
export function makeProject(configOverrides: Record<string, unknown> = {}): string {
  const dir = tmpDir();
  write(dir, "package.json", { name: "demo", version: "1.0.0" });
  write(dir, "check.cjs", "process.exit(require('fs').existsSync('src/impl.js') ? 0 : 1);\n");
  write(dir, ".claude/aw.config.json", {
    version: 1,
    commands: {
      test: "node check.cjs",
      testFiles: "node check.cjs {files}",
      lint: 'node -e "process.exit(0)"',
    },
    gates: {
      afterTests: [{ run: "testFiles", expect: "fail", onMismatch: "warn" }],
      afterCoding: [{ run: "lint" }, { run: "test" }],
    },
    docs: [{ path: "README.md", when: "usage changes" }],
    ...configOverrides,
  });
  write(dir, "README.md", "# demo\n");
  return dir;
}

export const TASK = "T-1";
export const taskDir = (dir: string) => path.join(dir, ".tasks", "active", TASK);
export const state = (dir: string) => readJson<TaskState>(dir, `.tasks/active/${TASK}/state.json`);

/** The run at `index` in start order; fails the test when there is none. */
export function runAt(taskState: TaskState, index: number): Run {
  const run = taskState.runs[index];
  if (!run) throw new Error(`the task has no run #${index}`);
  return run;
}

/** The run at `index`, narrowed to `role`; fails the test when it belongs to another role. */
export function runOfRole<R extends Role>(taskState: TaskState, index: number, role: R): Extract<Run, { role: R }> {
  const run = runAt(taskState, index);
  if (run.role !== role) throw new Error(`run #${index} belongs to the ${run.role}, not the ${role}`);
  return run as Extract<Run, { role: R }>;
}

export function runById(taskState: TaskState, id: string): Run {
  const run = taskState.runs.find((candidate) => candidate.id === id);
  if (!run) throw new Error(`the task has no run ${id}`);
  return run;
}

export const PLAN = {
  mode: "tdd",
  summary: "Add a limiter.",
  acceptanceCriteria: ["Blocks the 6th attempt.", "Success resets the counter."],
  contract: "`src/impl.js` exports `limit(ip)`.",
  approach: ["Write src/impl.js"],
};

export const TESTER_OUT = {
  summary: "Two unit tests.",
  tests: [
    { file: "tests/limit.test.js", title: "blocks the 6th attempt", kind: "unit", covers: ["AC-1"], edgeCase: true },
    { file: "tests/limit.test.js", title: "resets on success", kind: "unit", covers: ["AC-2"], edgeCase: false },
  ],
};

export const coverage = (verdict = "covered") => [
  { ac: "AC-1", verdict },
  { ac: "AC-2", verdict },
];

export const CODER_OUT = {
  summary: "Implemented the limiter.",
  filesChanged: [{ path: "src/impl.js", change: "added", why: "the limiter" }],
};

/** Drive a fresh project to READY_FOR_TESTS. */
export function toReadyForTests(dir: string): void {
  expectOk(cli(dir, ["sm", "new", "--title", "Limiter", "--id", TASK]));
  write(dir, `.tasks/active/${TASK}/requirements.md`, "Limit login attempts.\n");
  write(dir, "plan.json", PLAN);
  expectOk(cli(dir, ["sm", "plan", "--file", "plan.json"]));
  expectOk(cli(dir, ["sm", "approve"]));
}

/** Tester writes and submits tests; reviewer approves them → READY_FOR_CODING. */
export function toReadyForCoding(dir: string): void {
  toReadyForTests(dir);
  expectOk(cli(dir, ["tester", "start"]));
  write(dir, "tests/limit.test.js", "// tests\n");
  write(dir, outFile(dir), TESTER_OUT);
  expectOk(cli(dir, ["tester", "submit"]));
  expectOk(cli(dir, ["reviewer", "start"]));
  write(dir, outFile(dir), { summary: "Good tests.", verdict: "approve", acCoverage: coverage() });
  expectOk(cli(dir, ["reviewer", "submit"]));
}

/** Output file of the currently active run. */
export function outFile(dir: string): string {
  const active = state(dir).runs.find((candidate) => candidate.state === "active");
  if (!active) throw new Error("no active run");
  return active.outputFile;
}

export function expectOk(result: Result): Result {
  if (result.code !== 0) throw new Error(`expected exit 0, got ${result.code}\nstdout: ${result.out}\nstderr: ${result.err}`);
  return result;
}

// ---------------------------------------------------------------- refinements

export const SLICE = "users-slice";
export const sliceFile = (file: string) => `.tasks/refinements/${SLICE}/${file}`;
export const PROPOSAL = sliceFile("proposal.json");
export const refinement = (dir: string) => readJson<RefinementState>(dir, sliceFile("refinement.json"));

/** A proposal as the product owner writes it (fields with defaults may be left out). */
export type Proposal = z.input<typeof RefineOutput>;

/** A valid proposal: a prerequisite (the test database), then two items that deliver the slice. */
export const REFINE_OUT: Proposal = {
  summary: "Test database first, then create-and-read, then listing.",
  items: [
    {
      title: "Test database",
      goal: "Tests run against a clean database.",
      scope: ["docker compose service"],
      acceptanceCriteria: ["npm test uses the test database."],
      suggestedMode: "light",
      modeReason: "Configuration only.",
      prerequisiteFor: "Items 2 and 3 test against the database.",
    },
    {
      title: "Create and read a user",
      goal: "POST /users creates a user and GET /users/:id returns it.",
      scope: ["POST /users", "GET /users/:id"],
      acceptanceCriteria: ["POST /users returns 201.", "GET /users/:id returns 404 for an unknown id."],
      dependsOn: [1],
      suggestedMode: "tdd",
      modeReason: "New behavior.",
    },
    {
      title: "List users",
      goal: "GET /users returns users newest first.",
      scope: ["GET /users with paging"],
      acceptanceCriteria: ["GET /users returns users newest first."],
      dependsOn: [2],
      suggestedMode: "tdd",
      modeReason: "New behavior.",
    },
  ],
  coverage: [
    { requirement: "Users can be created and read.", items: [2] },
    { requirement: "Users can be listed.", items: [3] },
  ],
};

/** A refinement of SLICE with the product owner at work (status WORKING). */
export function toWorkingRefinement(dir: string): void {
  write(dir, "slice.md", "Users module: create, read and list users.\n");
  expectOk(cli(dir, ["refine", "new", "--title", "Users module", "--id", SLICE, "--input", "slice.md"]));
  expectOk(cli(dir, ["refine", "start-agent", SLICE]));
}

/** A refinement of SLICE with REFINE_OUT accepted as revision 1 (status PROPOSED). */
export function toProposedRefinement(dir: string): void {
  toWorkingRefinement(dir);
  write(dir, PROPOSAL, REFINE_OUT);
  expectOk(cli(dir, ["refine", "submit"]));
}
