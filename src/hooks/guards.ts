/**
 * PreToolUse guards. Deterministic rules that hold whatever the model decides:
 * - each agent may run only its own `aw <role>` commands; only the main session runs `aw sm`;
 * - `aw sm approve|accept|repair` always asks the user (human gates, also in auto mode);
 * - state.json is written only by the CLI;
 * - agents edit files only during their own active run, and only what their role may touch;
 * - agents run tests only through `aw test` (guards.directTestCommands);
 * - per-role Bash deny/allow lists;
 * - the product owner (refinements) writes only its proposal file and runs only `aw refine submit` / `aw schema refine`;
 * - `aw refine` belongs to the main session, and `aw refine approve` always asks the user.
 */
import { activeRun, latestRun } from "../core/machine";
import { type Ctx, rel } from "../core/project";
import { findWorkingRefinement, refinementPaths } from "../core/refinementStore";
import { findActiveTask, readState, type TaskRef } from "../core/store";
import { directTestCommandsBlocked, testCommandPrefixes } from "../core/tests";
import type { Config } from "../schema/config";
import type { TaskState } from "../schema/state";
import { Role, stepForWorking, WORKING_STATUSES } from "../schema/status";
import { relativeToRoot } from "../util/fsx";
import { globMatcher } from "../util/glob";
import { type Identity, identify, isAwAgent } from "./identity";
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
  if (!isAwAgent(who)) return null;
  const tool = input.tool_name ?? "";
  const onlyAw = (cmd: string) => splitSegments(cmd).every((seg) => findAwInvocations(seg).length > 0);
  const changes = EDIT_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && !onlyAw(String(input.tool_input?.command ?? "")));
  if (!changes) return null;
  return deny(
    `aw is not set up in this repository (no .claude/aw.config.json), so ${agentName(who)} may not change anything here. Stop and report this in one line.`,
  );
}

/** "the tester", "the product owner": an aw agent in messages. */
function agentName(who: Identity): string {
  return who.kind === "role" ? `the ${who.role}` : "the product owner";
}

/** `aw refine` actions that only read, so any agent outside the task pipeline may run them. */
const READ_ONLY_REFINE_ACTIONS = new Set(["next", "show"]);

/**
 * `aw refine …` belongs to the main session (the /aw:refine skill), except `submit`, which only the product owner runs.
 * The product owner's own commands are checked by checkProductOwnerShell.
 */
function checkRefine(who: Identity, action: string | undefined): Decision {
  if (who.kind === "role") return deny(`the ${who.role} may not run "aw refine …"; refinements happen outside the task pipeline.`);
  if (who.kind === "other" && !READ_ONLY_REFINE_ACTIONS.has(action ?? "")) {
    return deny("only the main session runs `aw refine` commands; other agents may only read (`aw refine next`, `aw refine show`).");
  }
  if (action === "submit") {
    return deny("`aw refine submit` is run by the aw:product-owner agent. Start one with `aw refine start-agent <id>`.");
  }
  if (action === "approve") {
    return ask('human gate — "aw refine approve" records YOUR decision. Confirm only if you approve the split into tasks.');
  }
  return null;
}

function checkAw(who: Identity, inv: AwInvocation): Decision {
  const { sub, action } = inv;
  if (sub === "hook") return deny("`aw hook` is reserved for Claude Code hooks.");
  if (sub === "refine") return checkRefine(who, action);
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

/**
 * The product owner's only commands, each a whole simple command: `aw refine submit` and `aw schema refine`,
 * launched as `aw` or `node …/aw.mjs`, optionally with `2>&1`. It reads the repository with Read, Grep and Glob.
 * Allowed: `aw refine submit`, `node "C:/x/cli/aw.mjs" refine submit 2>&1`, `aw schema refine`.
 * Denied: `ls`, `aw refine approve x`, `python -c "…aw refine submit…"`, `aw refine submit > out.txt`.
 */
const PRODUCT_OWNER_COMMAND =
  /^(?:(?:\S*[\\/])?aw(?:\.cmd)?|node (?:"[^"]*aw\.mjs"|'[^']*aw\.mjs'|\S*aw\.mjs)) (?:refine submit|schema refine)(?: 2>&1)?$/;

function checkProductOwnerShell(command: string): Decision {
  const isAllowed = (segment: string) => PRODUCT_OWNER_COMMAND.test(segment.replace(/\s+/g, " ").trim());
  const blocked = splitSegments(command).find((segment) => !isAllowed(segment));
  if (blocked === undefined) return null;
  return deny(
    `the product owner runs only "aw refine submit" and "aw schema refine" ("${firstWords(blocked)}" is not allowed). Read the repository with Read, Grep and Glob; write only your proposal file.`,
  );
}

function checkShell(ctx: Ctx, who: Identity, command: string): Decision {
  if (who.kind === "product-owner") return checkProductOwnerShell(command);
  for (const invocation of findAwInvocations(command)) {
    const decision = checkAw(who, invocation);
    if (decision) return decision;
  }
  if (writesStateFile(command)) return deny("state.json, refinement.json and their .sha256 seals are written only by the aw CLI. Use aw commands.");
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
  if (relPath && /(^|\/)(state|refinement)\.(json|sha256)$/.test(relPath) && inTasks) {
    return deny("state.json, refinement.json and their .sha256 seals are written only by the aw CLI. Use aw commands.");
  }
  if (who.kind === "product-owner") return checkProductOwnerEdit(ctx, relPath);
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

/** The product owner writes exactly one file: proposal.json of the refinement it works on (status WORKING). */
function checkProductOwnerEdit(ctx: Ctx, relPath: string | null): Decision {
  let working: ReturnType<typeof findWorkingRefinement>;
  try {
    working = findWorkingRefinement(ctx);
  } catch (e) {
    return deny(`cannot read the refinements: ${(e as Error).message}`);
  }
  if (!working) {
    return deny("no refinement has an active product-owner run, so the product owner may not write anything. Stop and report this in one line.");
  }
  const proposal = rel(ctx, refinementPaths(working.ref).proposal);
  if (relPath && samePath(relPath, proposal)) return null;
  return deny(`the product owner writes only its proposal, ${proposal}. Everything else goes into the proposal (summary, risks, openQuestions).`);
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
