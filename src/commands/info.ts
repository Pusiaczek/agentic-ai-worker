/** Read-mostly commands: show, schema, backlog, stats, doctor. */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { readRoleNotes } from "../core/briefing";
import { isIgnored } from "../core/git";
import { describeFinding, openBlockingFindings, pendingNotes } from "../core/machine";
import { formatNext, nextAction } from "../core/next";
import { type Ctx, findRoot, loadCtx, rel } from "../core/project";
import { contextDocFiles } from "../core/refinementContext";
import { findActiveTask, parseStateText, readArchivedTasks, readBacklog, readState, STATE_FILE, writeBacklog } from "../core/store";
import { directTestCommandsBlocked } from "../core/tests";
import type { Io } from "../io";
import { BacklogAction } from "../schema/commands";
import { Config, CONFIG_FILE } from "../schema/config";
import { EXAMPLES } from "../schema/examples";
import { INPUT_SCHEMAS, type InputSchemaName } from "../schema/outputs";
import { BacklogItem, BacklogStatus, RunState, type TaskState, TaskState as TaskStateSchema } from "../schema/state";
import { Role, Status } from "../schema/status";
import { bool, parseArgs, str } from "../util/args";
import { AwError, EXIT } from "../util/errors";
import { listFiles, nowIso, readTextIfExists } from "../util/fsx";
import { globMatcher } from "../util/glob";

// ---------------------------------------------------------------- show

function findArchived(ctx: Ctx, id: string): string | null {
  if (!fs.existsSync(ctx.archiveDir)) return null;
  const match = fs
    .readdirSync(ctx.archiveDir)
    .filter((d) => d === id || d.endsWith(`_${id}`) || /^-\d+$/.test(d.slice(id.length)) && d.startsWith(id))
    .sort()
    .at(-1);
  return match ? path.join(ctx.archiveDir, match) : null;
}

export function showCommand(argv: string[], io: Io): number {
  const args = parseArgs(argv, ["json"]);
  const ctx = loadCtx(io.cwd);
  const taskId = str(args, "task");
  let s: TaskState | null = null;
  if (taskId) {
    const dir = findArchived(ctx, taskId);
    if (!dir) throw new AwError(`No archived task ${taskId} in ${rel(ctx, ctx.archiveDir)}.`);
    s = parseStateText(fs.readFileSync(path.join(dir, STATE_FILE), "utf8"), taskId);
  } else {
    const ref = findActiveTask(ctx);
    if (ref) s = readState(ref);
  }
  if (!s) {
    io.out("No active task.");
    return EXIT.OK;
  }
  if (bool(args, "json")) {
    io.out(JSON.stringify(s, null, 2));
    return EXIT.OK;
  }
  const plan = s.plans.find((p) => p.revision === s.approvedPlanRevision) ?? s.plans.at(-1);
  io.out(`# ${s.id} · ${s.title}`);
  io.out(`Status: ${s.status} · mode: ${s.mode} · plan revision: ${plan?.revision ?? "—"}${s.approvedPlanRevision ? " (approved)" : ""}`);
  if (s.blocked) io.out(`Blocked: ${s.blocked.reason} (from ${s.blocked.from})`);
  if (plan) {
    io.out("\nAcceptance criteria:");
    for (const a of plan.acceptanceCriteria) io.out(`  ${a.id}: ${a.text}`);
  }
  if (s.runs.length) {
    io.out("\nRuns:");
    for (const r of s.runs) {
      const what = r.role === Role.enum.reviewer ? `reviewer/${r.target}` : r.role;
      const verdict = r.role === Role.enum.reviewer && r.output ? ` → ${r.output.verdict}` : "";
      const rejects = r.submitAttempts.filter((a) => !a.ok).length;
      io.out(`  ${r.id} ${what} #${r.iteration} ${r.state}${verdict}${rejects ? ` (${rejects} rejected submit(s))` : ""}`);
      if (r.output) io.out(`      ${r.output.summary.split("\n")[0]}`);
    }
  }
  for (const target of ["tests", "code"] as const) {
    const open = openBlockingFindings(s, target);
    if (open.length) {
      io.out(`\nOpen blocking findings (${target}):`);
      for (const f of open) io.out(`  ${describeFinding(f)}`);
    }
  }
  for (const role of Role.options) {
    const notes = pendingNotes(s, role);
    if (notes.length) io.out(`\nPending notes for ${role}: ${notes.map((n) => `${n.id} ${n.text}`).join(" | ")}`);
  }
  const followUps = s.runs.flatMap((r) => (r.role === Role.enum.reviewer && r.output ? r.output.followUps.map((f) => f.text) : []));
  if (followUps.length) io.out(`\nFollow-ups:\n${followUps.map((f) => `  - ${f}`).join("\n")}`);
  const questions = s.runs.flatMap((r) => r.output?.openQuestions.map((q) => `${r.id}: ${q}`) ?? []);
  if (questions.length) io.out(`\nOpen questions:\n${questions.map((q) => `  - ${q}`).join("\n")}`);
  io.out("\nRecent history:");
  for (const e of s.history.slice(-8)) {
    io.out(`  ${e.at} ${e.by}: ${e.type === "transition" ? `${e.from} → ${e.to}` : e.event}${e.note ? ` — ${e.note}` : ""}`);
  }
  if (!taskId) io.out(`\n${formatNext(null, nextAction(ctx, s))}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- schema

const SCHEMA_NAMES = [...Object.keys(INPUT_SCHEMAS), "config", "state"];

/** What `aw schema <name>` prints: the repo config, the task state, or an agent's or the orchestrator's input. */
function schemaByName(name: string): z.ZodType {
  if (name === "config") return Config;
  if (name === "state") return TaskStateSchema;
  return INPUT_SCHEMAS[name as InputSchemaName];
}

export function schemaCommand(argv: string[], io: Io): number {
  const name = argv[0];
  if (!name || !SCHEMA_NAMES.includes(name)) {
    throw new AwError(`Usage: aw schema <${SCHEMA_NAMES.join("|")}>`, EXIT.USAGE);
  }
  const json = z.toJSONSchema(schemaByName(name), { io: name === "state" ? "output" : "input", unrepresentable: "any" });
  io.out(`JSON Schema for ${name}${name in INPUT_SCHEMAS ? " (fields with defaults may be omitted; unknown fields are rejected)" : ""}:`);
  io.out(JSON.stringify(json, null, 2));
  const example = EXAMPLES[name as InputSchemaName];
  if (example) {
    io.out(`\nExample:`);
    io.out(JSON.stringify(example, null, 2));
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------- backlog

export function backlogCommand(argv: string[], io: Io): number {
  const ctx = loadCtx(io.cwd);
  const args = parseArgs(argv, ["all", "json"]);
  const backlog = readBacklog(ctx);
  if (args.positionals[0] === BacklogAction.enum.set) {
    const [, id, status] = args.positionals;
    const parsedStatus = BacklogItem.shape.status.safeParse(status);
    if (!id || !parsedStatus.success) {
      throw new AwError("Usage: aw backlog set <B-id> <open|accepted|ticket|done|rejected> [--note \"...\"]", EXIT.USAGE);
    }
    const item = backlog.items.find((i) => i.id === id);
    if (!item) throw new AwError(`No backlog item ${id}.`);
    item.status = parsedStatus.data;
    item.updatedAt = nowIso();
    const note = str(args, "note");
    if (note) item.note = note;
    writeBacklog(ctx, backlog);
    io.out(`${id} → ${item.status}`);
    return EXIT.OK;
  }
  const kind = str(args, "kind");
  const items = backlog.items.filter((i) => (bool(args, "all") || i.status === BacklogStatus.enum.open) && (!kind || i.kind === kind));
  if (bool(args, "json")) {
    io.out(JSON.stringify(items, null, 2));
    return EXIT.OK;
  }
  if (!items.length) {
    io.out(bool(args, "all") ? "Backlog is empty." : "No open backlog items (use --all to see everything).");
    return EXIT.OK;
  }
  for (const i of items) io.out(`${i.id} [${i.kind}/${i.status}] ${i.text}  (${i.taskId}${i.runId ? ` ${i.runId}` : ""}${i.role ? `, ${i.role}` : ""})`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- stats

export function statsCommand(_argv: string[], io: Io): number {
  const ctx = loadCtx(io.cwd);
  const { tasks, unreadable } = readArchivedTasks(ctx);
  for (const directory of unreadable) io.err(`skipping ${directory}: unreadable state`);
  if (!tasks.length) {
    io.out("No archived tasks yet.");
    return EXIT.OK;
  }
  const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "—");
  const count = (s: TaskState, role: Role) => s.runs.filter((r) => r.role === role && r.state === RunState.enum.submitted).length;
  const tally = new Map<string, number>();
  const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
  let rejected = 0;
  let stopBlocks = 0;
  const testTime = new Map<string, { runs: number; ms: number }>();
  const blocks: string[] = [];
  const notes: string[] = [];
  for (const s of tasks) {
    for (const r of s.runs) {
      rejected += r.submitAttempts.filter((a) => !a.ok).length;
      stopBlocks += r.stopBlocks;
      const t = testTime.get(r.role) ?? { runs: 0, ms: 0 };
      t.runs += r.testRuns.length;
      t.ms += r.testRuns.reduce((sum, x) => sum + x.durationMs, 0);
      testTime.set(r.role, t);
      if (r.role === Role.enum.reviewer && r.output) for (const f of r.output.findings) bump(`${f.severity} · ${f.category}`);
      for (const n of r.output?.processNotes ?? []) notes.push(`${s.id} ${r.role}: ${n}`);
    }
    for (const h of s.history) if (h.type === "transition" && h.to === Status.enum.BLOCKED) blocks.push(`${s.id}: ${h.note ?? ""}`);
  }
  const done = tasks.filter((t) => t.status === Status.enum.DONE);
  io.out(`Archived tasks: ${tasks.length} (done ${done.length}, cancelled ${tasks.length - done.length})`);
  const testIterations = avg(tasks.map((t) => count(t, Role.enum.tester)));
  const codeIterations = avg(tasks.map((t) => count(t, Role.enum.coder)));
  io.out(`Avg iterations per task — tests: ${testIterations}, code: ${codeIterations}`);
  io.out(`Avg plan revisions: ${avg(tasks.map((t) => t.plans.length))}`);
  io.out(`Rejected submissions: ${rejected} · agents stopped before submitting: ${stopBlocks}`);
  const testLines = [...testTime.entries()]
    .filter(([, t]) => t.runs)
    .map(([role, t]) => `${role} ${t.runs} run(s), ${Math.round(t.ms / 1000)}s`);
  if (testLines.length) io.out(`\`aw test\` by agents: ${testLines.join(" · ")}`);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) io.out(`\nFindings by severity · category:\n${top.map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`).join("\n")}`);
  if (blocks.length) io.out(`\nBlocks:\n${blocks.slice(-10).map((b) => `  - ${b}`).join("\n")}`);
  if (notes.length) io.out(`\nRecent process notes:\n${notes.slice(-15).map((n) => `  - ${n}`).join("\n")}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- doctor


function scriptOf(command: string): string | null {
  const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(command.trim());
  if (!m) return null;
  return m[1] === "test" || m[1] === "t" ? "test" : m[1]!;
}

export function doctorCommand(_argv: string[], io: Io): number {
  let problems = 0;
  const ok = (m: string) => io.out(`✓ ${m}`);
  const warn = (m: string) => io.out(`! ${m}`);
  const bad = (m: string) => {
    problems++;
    io.out(`✗ ${m}`);
  };

  const root = findRoot(io.cwd);
  if (!root) {
    bad(`${CONFIG_FILE} not found — run /aw:init`);
    return EXIT.NOT_INITIALIZED;
  }
  let ctx: Ctx;
  try {
    ctx = loadCtx(io.cwd);
    ok(`config valid: ${path.join(root, CONFIG_FILE)}`);
  } catch (e) {
    bad((e as Error).message);
    return EXIT.VALIDATION;
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} — aw needs >= 20`);

  const pkg = readTextIfExists(path.join(ctx.root, "package.json"));
  const scripts: Record<string, string> = pkg ? (JSON.parse(pkg).scripts ?? {}) : {};
  for (const [name, command] of Object.entries(ctx.config.commands)) {
    const script = scriptOf(command);
    if (script && !(script in scripts)) bad(`commands.${name}: "${command}" — package.json has no script "${script}"`);
    else ok(`commands.${name}: ${command}`);
  }
  if (!ctx.config.gates.afterCoding.length) warn("gates.afterCoding is empty — code is submitted without running any checks");
  if (!ctx.config.commands.testFiles) {
    const missing = 'commands.testFiles is missing — `aw test` can\'t run tests (e.g. "npx vitest run {files}")';
    // With direct test commands blocked, agents would have no way to run tests at all.
    if (directTestCommandsBlocked(ctx.config)) bad(`${missing}, and agents are blocked from running the test runner directly`);
    else warn(missing);
  }

  const files = listFiles(ctx.root);
  const isTest = globMatcher(ctx.config.tests.globs);
  const tests = files.filter(isTest).length;
  if (tests) ok(`tests.globs match ${tests} existing file(s)`);
  else warn("tests.globs match no existing files — check the globs (the tester can only write files matching them)");

  for (const d of ctx.config.docs) {
    if (!fs.existsSync(path.join(ctx.root, d.path))) bad(`docs: ${d.path} does not exist`);
    else if (/TODO/i.test(d.when)) warn(`docs: ${d.path} — "when" is still TODO`);
    else ok(`docs: ${d.path}`);
  }
  if (!ctx.config.docs.length) warn("docs index is empty — the docs check will have nothing to compare against");
  const contextDocs = contextDocFiles(ctx);
  if (contextDocs.length) ok(`refine.contextDocs: ${contextDocs.length} file(s) the product owner reads before splitting`);
  else warn(`refine.contextDocs (${ctx.config.refine.contextDocs.join(", ")}) matches no files — /aw:refine will ask for the project documentation`);

  for (const name of [...Role.options, "scrum-master", "product-owner"]) {
    const file = path.join(ctx.roleNotesDir, `${name}.md`);
    if (!fs.existsSync(file)) warn(`role notes missing: ${rel(ctx, file)}`);
    else if (!readRoleNotes(ctx, name)) warn(`role notes are still an empty template: ${rel(ctx, file)}`);
    else ok(`role notes: ${rel(ctx, file)}`);
  }
  const instructions = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"].filter((f) => fs.existsSync(path.join(ctx.root, f)));
  if (instructions.length) ok(`project instructions: ${instructions.join(", ")}`);
  else warn("no CLAUDE.md / CLAUDE.local.md — agents start without project instructions (see /aw:init)");
  if (instructions.includes("CLAUDE.local.md") && !instructions.some((f) => f !== "CLAUDE.local.md") && fs.existsSync(path.join(ctx.root, "AGENTS.md"))) {
    const local = readTextIfExists(path.join(ctx.root, "CLAUDE.local.md")) ?? "";
    if (!/^@AGENTS\.md\s*$/m.test(local)) warn("CLAUDE.local.md hides AGENTS.md (Claude reads AGENTS.md only without CLAUDE*.md) — add a line `@AGENTS.md` to CLAUDE.local.md");
  }

  const tasksRel = ctx.config.paths.tasksDir.replace(/^\.\//, "").replace(/\/$/, "");
  const tracesIgnored = isIgnored(ctx.root, `${tasksRel}/probe`);
  if (tracesIgnored === null) warn("not a git repository — can't check what git would commit");
  else {
    if (tracesIgnored) ok(`${tasksRel}/ is ignored by git`);
    else bad(`${tasksRel}/ is NOT ignored by git — task traces would show up in commits (run \`aw init\` or \`aw init --shared\`)`);
    const local = isIgnored(ctx.root, CONFIG_FILE);
    if (local) {
      const leaks = [".claude/aw.config.schema.json", `${ctx.config.paths.roleNotesDir.replace(/\/$/, "")}/probe.md`].filter((p) => !isIgnored(ctx.root, p));
      if (leaks.length) warn(`local mode, but not hidden from git: ${leaks.join(", ")} — rerun \`aw init\``);
      else ok("mode: local (\"ghost\") — aw's files are invisible to git");
    } else ok("mode: shared — commit .claude/aw.config.json, .claude/aw.config.schema.json and the role notes");
  }

  try {
    const ref = findActiveTask(ctx);
    if (ref) {
      const s = readState(ref);
      ok(`active task ${s.id}: ${s.status} (state integrity ok)`);
    } else ok("no active task");
  } catch (e) {
    bad((e as Error).message);
  }
  io.out(problems ? `\n${problems} problem(s).` : "\nAll good.");
  return problems ? EXIT.ERROR : EXIT.OK;
}
