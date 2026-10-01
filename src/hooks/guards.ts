/**
 * PreToolUse guards. Deterministic rules that hold whatever the model decides:
 * - each agent may run only its own `aw <role>` commands; only the main session runs `aw sm`;
 * - `aw sm approve|accept|repair` always asks the user (human gates, also in auto mode);
 * - state.json is written only by the CLI;
 * - agents edit files only during their own active run, and only what their role may touch;
 * - agents run tests only through `aw test` (guards.directTestCommands);
 * - per-role Bash deny/allow lists.
 */
import { activeRun, latestRun } from "../core/machine";
import type { Ctx } from "../core/project";
import { findActiveTask, readState, type TaskRef } from "../core/store";
import { directTestCommandsBlocked, testCommandPrefixes } from "../core/tests";
import type { Config } from "../schema/config";
import type { TaskState } from "../schema/state";
import { Role, stepForWorking, WORKING_STATUSES } from "../schema/status";
import { relativeToRoot } from "../util/fsx";
import { globMatcher } from "../util/glob";
import { type Identity, identify } from "./identity";
import { type AwInvocation, findAwInvocations, splitSegments, startsWithCommand, writesStateFile } from "./shell";

export interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  agent_type?: string;
  agent_id?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

export type Decision = { permissionDecision: "deny" | "ask"; reason: string } | null;

const deny = (reason: string): Decision => ({ permissionDecision: "deny", reason: `aw: ${reason}` });
const ask = (reason: string): Decision => ({ permissionDecision: "ask", reason: `aw: ${reason}` });

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const HUMAN_GATES: Record<string, string> = {
  approve: "approve the plan",
  accept: "accept the finished work",
  repair: "want to accept a manual edit of state.json",
};
const ALWAYS_ALLOWED = ["cd", "pwd"];

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

interface Task {
  ref: TaskRef;
  s: TaskState;
}

function loadTask(ctx: Ctx): { task: Task | null; error: string | null } {
  try {
    const ref = findActiveTask(ctx);
    return { task: ref ? { ref, s: readState(ref) } : null, error: null };
  } catch (e) {
    return { task: null, error: (e as Error).message };
  }
}

export function preToolUse(ctx: Ctx, input: HookInput): Decision {
  const who = identify(input.agent_type);
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  if (SHELL_TOOLS.has(tool)) return checkShell(ctx, who, String(ti.command ?? ""));
  if (EDIT_TOOLS.has(tool)) {
    const file = [ti.file_path, ti.notebook_path, ti.path].find((v): v is string => typeof v === "string");
    return file ? checkEdit(ctx, who, file, input.cwd ?? ctx.root) : null;
  }
  if (tool === "SubagentHandback" && who.kind === "role") return checkHandback(ctx, who.role, String(ti.message ?? ""));
  return null;
}

/**
 * In a repository without aw config the hooks stay out of the way — except for aw's own agents,
 * which have no business there: they may read, but not change anything.
 */
export function guardUninitialized(input: HookInput): Decision {
  const who = identify(input.agent_type);
  if (who.kind !== "role") return null;
  const tool = input.tool_name ?? "";
  const onlyAw = (cmd: string) => splitSegments(cmd).every((seg) => findAwInvocations(seg).length > 0);
  const changes = EDIT_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && !onlyAw(String(input.tool_input?.command ?? "")));
  if (!changes) return null;
  return deny(
    `aw is not set up in this repository (no .claude/aw.config.json), so the ${who.role} may not change anything here. Stop and report this in one line.`,
  );
}

function checkAw(who: Identity, inv: AwInvocation): Decision {
  const { sub, action } = inv;
  if (sub === "hook") return deny("`aw hook` is reserved for Claude Code hooks.");
  if (sub === "sm") {
    if (who.kind === "role") return deny(`the ${who.role} may not run orchestrator commands (aw sm …). Use \`aw ${who.role} …\`.`);
    if (who.kind === "other" && action !== "next") return deny("only the main session (scrum-master) runs `aw sm` commands.");
    if (action && action in HUMAN_GATES) {
      return ask(`human gate — "aw sm ${action}" records YOUR decision. Confirm only if you ${HUMAN_GATES[action]}.`);
    }
    return null;
  }
  if (Role.options.includes(sub as Role)) {
    if (who.kind === "role" && who.role !== sub) return deny(`you are the ${who.role}; "aw ${sub} …" belongs to the ${sub}. Use \`aw ${who.role} …\`.`);
    if (who.kind !== "role") return deny(`"aw ${sub} ${action ?? ""}" may only be run by the aw:${sub} subagent. Spawn it instead (see \`aw sm next\`).`);
    return null;
  }
  if (who.kind === "role" && (sub === "init" || (sub === "backlog" && action === "set"))) {
    return deny(`the ${who.role} may not run "aw ${sub}${action ? ` ${action}` : ""}".`);
  }
  return null;
}

/** First words of a command, for readable deny messages. */
const firstWords = (command: string, count = 3) => command.split(/\s+/).slice(0, count).join(" ");

/**
 * The first simple command that starts a test runner directly, if any.
 * `segments` is the shell command split into simple commands (`a && b | c` → a, b, c).
 * A segment matches a prefix as whole words — "npm test", "npm test -- -u", "npx vitest run a.test.ts" —
 * or as an npm script variant — "npm run test:unit". "npm install" or "npm tester" don't match "npm test".
 */
function findTestRunnerCall(config: Config, segments: string[]): string | undefined {
  const prefixes = testCommandPrefixes(config);
  const startsTestRunner = (segment: string) =>
    prefixes.some((prefix) => startsWithCommand(segment, prefix) || segment.startsWith(`${prefix}:`));
  return segments.find(startsTestRunner);
}

const useAwTestInstead = (call: string) =>
  `run tests through \`aw test\`, not "${firstWords(call)}". \`aw test\` runs this task's test files; narrow it with -t "<test name>" or pass files. Don't run the whole suite — submit runs it once as a gate.`;

function checkShell(ctx: Ctx, who: Identity, command: string): Decision {
  for (const invocation of findAwInvocations(command)) {
    const decision = checkAw(who, invocation);
    if (decision) return decision;
  }
  if (writesStateFile(command)) return deny("state.json / state.sha256 are written only by the aw CLI. Use aw commands.");
  if (who.kind !== "role") return null;

  // `aw …` calls were checked above; the rules below apply to everything else in the command.
  const segments = splitSegments(command).filter((segment) => findAwInvocations(segment).length === 0);

  if (directTestCommandsBlocked(ctx.config)) {
    const testRunnerCall = findTestRunnerCall(ctx.config, segments);
    if (testRunnerCall) return deny(useAwTestInstead(testRunnerCall));
  }

  const deniedPrefix = ctx.config.guards.bashDeny.find((prefix) => segments.some((segment) => startsWithCommand(segment, prefix)));
  if (deniedPrefix) {
    return deny(`"${deniedPrefix}" is not allowed for aw agents (guards.bashDeny). The user handles git history and publishing.`);
  }

  const policy = ctx.config.agents[who.role].bashAllow;
  if (policy.includes("*")) return null;
  const configuredCommands = Object.values(ctx.config.commands).map((command) => command.split("{")[0]!.trim());
  const allowed = [...policy, ...configuredCommands, ...ALWAYS_ALLOWED];
  const notAllowed = segments.find((segment) => !allowed.some((prefix) => startsWithCommand(segment, prefix)));
  if (notAllowed) {
    return deny(`"${firstWords(notAllowed)}" is not in agents.${who.role}.bashAllow. Allowed prefixes: ${allowed.join(", ")}.`);
  }
  return null;
}

function checkEdit(ctx: Ctx, who: Identity, file: string, cwd: string): Decision {
  const relPath = relativeToRoot(ctx.root, file, cwd);
  const tasksRel = relativeToRoot(ctx.root, ctx.tasksDir) ?? "";
  const inTasks = relPath !== null && tasksRel !== "" && (relPath + "/").toLowerCase().startsWith(`${tasksRel}/`.toLowerCase());
  if (relPath && /(^|\/)state\.(json|sha256)$/.test(relPath) && inTasks) {
    return deny("state.json / state.sha256 are written only by the aw CLI. Use aw commands.");
  }
  const { task, error } = loadTask(ctx);

  if (who.kind !== "role") {
    if (task && ctx.config.guards.blockMainSessionEditsDuringRuns && WORKING_STATUSES.includes(task.s.status) && !inTasks) {
      return deny(
        `an aw agent run is in progress (task ${task.s.id}, status ${task.s.status}). Don't edit project files meanwhile — wait for the agent, or \`aw sm reset\` first.`,
      );
    }
    return null;
  }

  const role = who.role;
  if (error) return deny(`cannot read the task state: ${error}`);
  if (!task) return deny(`there is no active aw task, so the ${role} may not edit files.`);
  const run = activeRun(task.s);
  if (!stepForWorking(role, task.s.status) || !run || run.role !== role) {
    return deny(
      `STATUS MISMATCH — the ${role} has no active run (task status ${task.s.status}). Run \`aw ${role} start\`; if it fails, stop and report the error.`,
    );
  }
  if (!relPath) return deny(`${file} is outside the project.`);
  if (samePath(relPath, run.outputFile)) return null;
  if (inTasks) return deny(`inside ${tasksRel}/ the ${role} may only write its output file ${run.outputFile}.`);
  if (role === "reviewer") return deny(`the reviewer is read-only. Write only your output JSON: ${run.outputFile}.`);
  if (role === "tester") {
    const isTest = globMatcher(ctx.config.tests.globs);
    if (!isTest(relPath)) {
      return deny(`the tester may only write test files (tests.globs: ${ctx.config.tests.globs.join(", ")}). ${relPath} is not one — production code belongs to the coder.`);
    }
    return null;
  }
  if (task.s.protectedFiles.some((p) => samePath(p.path, relPath))) {
    return deny(`${relPath} is a protected test file (approved by the reviewer). Don't change it; if you believe it's wrong, report it in testDisputes.`);
  }
  return null;
}

function checkHandback(ctx: Ctx, role: Role, message: string): Decision {
  const { task } = loadTask(ctx);
  if (!task) return null;
  const run = latestRun(task.s, role);
  if (run?.state === "active") return deny(`finish the aw protocol before handing back: \`aw ${role} submit\` or \`aw ${role} fail --reason "<why>"\`.`);
  const max = ctx.config.limits.finalMessageMaxChars;
  if (message.length > max) {
    return deny(`hand back ONE line (max ${max} chars), e.g. "${role} ${run?.id ?? "R-?"}: submitted — <≤15 words>". Details are already in the state file.`);
  }
  return null;
}
