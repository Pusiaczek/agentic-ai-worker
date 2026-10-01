/**
 * `aw tester|reviewer|coder start|submit|fail` — the only way agents touch the task state.
 * start: refuses unless the status is the role's READY_* status. submit: validates the output file,
 * runs gates, stores the output (append-only) and moves the task on.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildBriefing } from "../core/briefing";
import { describeGate, runGates } from "../core/gates";
import {
  activeRun,
  addEvent,
  latestSubmittedTester,
  nextId,
  pendingNotes,
  protectedTests,
  submittedRuns,
  transition,
} from "../core/machine";
import { type Ctx, loadCtx, rel } from "../core/project";
import { findActiveTask, mutate, readState, requireActiveTask, type TaskRef, taskPaths, withLock, writeState } from "../core/store";
import { checkCoder, checkReviewer, checkTester } from "../core/validate";
import type { Io } from "../io";
import type { Gate } from "../schema/config";
import { type CoderOutput, INPUT_SCHEMAS, type ReviewerOutput, type TesterOutput } from "../schema/outputs";
import type { GateResult, Run, TaskState } from "../schema/state";
import { type Role, ROLE_STEPS, type Status, stepForReady, stepForWorking } from "../schema/status";
import { parseArgs, requireStr } from "../util/args";
import { AwError, EXIT } from "../util/errors";
import { ensureDir, fileSha256, nowIso } from "../util/fsx";
import { formatIssues } from "../util/zod";

export function roleCommand(role: Role, argv: string[], io: Io): number {
  const [sub, ...rest] = argv;
  const ctx = loadCtx(io.cwd);
  switch (sub) {
    case "start": return start(ctx, role, io);
    case "submit": return submit(ctx, role, io);
    case "fail": return fail(ctx, role, requireStr(parseArgs(rest), "reason", `aw ${role} fail --reason "<why>"`), io);
    default:
      throw new AwError(sub ? `Unknown command: aw ${role} ${sub}` : `Missing command.`, EXIT.USAGE, `Usage: aw ${role} start | submit | fail --reason "<why>"`);
  }
}

function mismatch(role: Role, status: Status | null, action: string): AwError {
  const allowed = ROLE_STEPS[role].map((s) => (action === "start" ? s.ready : s.working)).join(" or ");
  return new AwError(
    `STATUS MISMATCH — the ${role} cannot ${action}: ${status ? `task status is ${status}` : "there is no active task"}; ${action} requires ${allowed}.\n` +
      "Do NOT do any work. Reply to the orchestrator with this error in one line and stop.",
    EXIT.STATUS_MISMATCH,
  );
}

function releaseNotes(s: TaskState, runId: string): void {
  for (const n of s.notes) if (n.consumedByRun === runId) delete n.consumedByRun;
}

// ---------------------------------------------------------------- start

function start(ctx: Ctx, role: Role, io: Io): number {
  const ref = findActiveTask(ctx);
  if (!ref) throw mismatch(role, null, "start");
  const { s, run } = mutate(ref, (s) => {
    const step = stepForReady(role, s.status);
    if (!step) throw mismatch(role, s.status, "start");
    const id = nextId(s, "run", "R");
    const notes = pendingNotes(s, role);
    for (const n of notes) n.consumedByRun = id;
    const agentId = s.lastSpawn[role]?.agentId;
    const base = {
      id,
      iteration: submittedRuns(s, role, step.target).length + 1,
      state: "active" as const,
      startedAt: nowIso(),
      outputFile: rel(ctx, path.join(taskPaths(ref).out, `${id}-${role}.json`)),
      submitAttempts: [],
      testRuns: [],
      gates: [],
      warnings: [],
      consumedNotes: notes.map((n) => n.id),
      stopBlocks: 0,
      finalMessageBlocks: 0,
      stoppedWithoutSubmit: false,
      ...(agentId ? { agentId } : {}),
    };
    const run: Run =
      role === "reviewer" ? { role, target: step.target!, ...base }
      : role === "tester" ? { role, ...base }
      : { role, ...base };
    s.runs.push(run);
    transition(s, step.working, role, `run ${id} started`);
    return { s, run };
  });
  ensureDir(taskPaths(ref).out);
  io.out(buildBriefing(ctx, ref, s, run));
  return EXIT.OK;
}

// ---------------------------------------------------------------- submit

type Output = TesterOutput | ReviewerOutput | CoderOutput;

type Precheck =
  | { ok: false; errors: string[]; attempt: number; max: number; outputFile: string }
  | { ok: true; runId: string; output: Output; warnings: string[]; state: TaskState };

function precheck(ctx: Ctx, ref: TaskRef, role: Role): Precheck {
  return withLock(ref, () => {
    const s = readState(ref);
    const run = activeRun(s);
    if (!run || run.role !== role || !stepForWorking(role, s.status)) throw mismatch(role, s.status, "submit");
    const max = ctx.config.limits.maxSubmitAttempts;
    if (run.submitAttempts.length >= max) {
      throw new AwError(`Submit attempt limit reached (${max}) for run ${run.id}.`, EXIT.VALIDATION, `Run \`aw ${role} fail --reason "<why>"\` and stop.`);
    }

    const errors: string[] = [];
    let output: Output | undefined;
    const abs = path.join(ctx.root, run.outputFile);
    if (!fs.existsSync(abs)) errors.push(`output file not found: ${run.outputFile}`);
    else {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (e) {
        errors.push(`${run.outputFile} is not valid JSON: ${(e as Error).message}`);
      }
      if (raw !== undefined) {
        const parsed = INPUT_SCHEMAS[role].safeParse(raw);
        if (parsed.success) output = parsed.data;
        else errors.push(...formatIssues(parsed.error));
      }
    }
    let warnings: string[] = [];
    if (output) {
      const check =
        run.role === "tester" ? checkTester(ctx, s, run, output as TesterOutput)
        : run.role === "coder" ? checkCoder(ctx, s, run, output as CoderOutput)
        : checkReviewer(ctx, s, run, output as ReviewerOutput);
      errors.push(...check.errors);
      warnings = check.warnings;
    }
    if (errors.length || !output) {
      run.submitAttempts.push({ at: nowIso(), ok: false, errors });
      addEvent(s, role, "submit_rejected", `${errors.length} error(s)`, run.id);
      writeState(ref, s);
      return { ok: false, errors, attempt: run.submitAttempts.length, max, outputFile: run.outputFile };
    }
    return { ok: true, runId: run.id, output, warnings, state: s };
  });
}

const unique = (xs: string[]) => [...new Set(xs)];

function gatesFor(ctx: Ctx, role: Role, s: TaskState, output: Output): { gates: Gate[]; files: string[] } {
  if (role === "tester") {
    const o = output as TesterOutput;
    return { gates: ctx.config.gates.afterTests, files: unique([...o.tests.map((t) => t.file)]) };
  }
  if (role === "coder") {
    const o = output as CoderOutput;
    const files = s.mode === "tdd" ? protectedTests(s).map((t) => t.file) : [];
    return { gates: ctx.config.gates.afterCoding, files: unique([...files, ...o.testsAdded.map((t) => t.file)]) };
  }
  return { gates: [], files: [] };
}

function snapshotProtected(ctx: Ctx, ref: TaskRef, s: TaskState): void {
  const tester = latestSubmittedTester(s);
  if (!tester?.output) return;
  const files = unique([...tester.output.tests.map((t) => t.file), ...tester.output.supportFiles]);
  const dir = taskPaths(ref).protected;
  fs.rmSync(dir, { recursive: true, force: true });
  s.protectedFiles = files.map((f) => {
    const abs = path.join(ctx.root, f);
    const snapshot = path.join(dir, f);
    ensureDir(path.dirname(snapshot));
    fs.copyFileSync(abs, snapshot);
    return { path: f, sha256: fileSha256(abs)!, snapshot: rel(ctx, snapshot) };
  });
  addEvent(s, "reviewer", "tests_protected", `${files.length} file(s) snapshotted`);
}

/** Store the output with CLI-assigned ids and move the task to its next status. */
function complete(ctx: Ctx, ref: TaskRef, s: TaskState, run: Run, output: Output): string[] {
  const limits = ctx.config.limits;
  const lines: string[] = [];
  if (run.role === "tester") {
    const o = output as TesterOutput;
    run.output = { ...o, tests: o.tests.map((t) => ({ ...t, id: nextId(s, "test", "T") })) };
    transition(s, "READY_FOR_TEST_REVIEW", "tester", `run ${run.id} submitted`);
    lines.push(`Tests registered: ${run.output.tests.map((t) => t.id).join(", ")}`);
  } else if (run.role === "reviewer") {
    const o = output as ReviewerOutput;
    run.output = { ...o, findings: o.findings.map((f) => ({ ...f, id: nextId(s, "finding", "F") })) };
    const approved = o.verdict === "approve";
    if (run.target === "tests") {
      const done = submittedRuns(s, "tester").length;
      if (approved) {
        snapshotProtected(ctx, ref, s);
        transition(s, "READY_FOR_CODING", "reviewer", "tests approved");
      } else if (done >= limits.maxTestIterations) {
        transition(s, "BLOCKED", "reviewer", `tests still need changes after ${done} tester iteration(s) (limit ${limits.maxTestIterations})`);
      } else transition(s, "READY_FOR_TESTS", "reviewer", "changes requested on tests");
    } else {
      const done = submittedRuns(s, "coder").length;
      if (approved) transition(s, ctx.config.flow.docsCheck ? "DOCS_CHECK" : "AWAITING_ACCEPTANCE", "reviewer", "code approved");
      else if (done >= limits.maxCodeIterations) {
        transition(s, "BLOCKED", "reviewer", `code still needs changes after ${done} coder iteration(s) (limit ${limits.maxCodeIterations})`);
      } else transition(s, "READY_FOR_CODING", "reviewer", "changes requested on code");
    }
    if (run.output.findings.length) lines.push(`Findings registered: ${run.output.findings.map((f) => `${f.id} (${f.severity})`).join(", ")}`);
  } else {
    const o = output as CoderOutput;
    run.output = o;
    if (o.testDisputes.length) {
      transition(s, "BLOCKED", "coder", `test dispute: ${o.testDisputes.map((d) => `${d.testId}: ${d.reason}`).join("; ")}`);
    } else transition(s, "READY_FOR_CODE_REVIEW", "coder", `run ${run.id} submitted`);
  }
  return lines;
}

function submit(ctx: Ctx, role: Role, io: Io): number {
  const ref = findActiveTask(ctx);
  if (!ref) throw mismatch(role, null, "submit");
  const pre = precheck(ctx, ref, role);
  if (!pre.ok) {
    io.err(`Submission rejected (attempt ${pre.attempt}/${pre.max}). Fix ${pre.outputFile} and run \`aw ${role} submit\` again:`);
    io.err(pre.errors.map((e) => `  - ${e}`).join("\n"));
    io.err(`Format reference: \`aw schema ${role}\`. If you cannot fix it: \`aw ${role} fail --reason "<why>"\`.`);
    return EXIT.VALIDATION;
  }

  // Gates run outside the lock: they can take minutes.
  const { gates: gateCfgs, files } = gatesFor(ctx, role, pre.state, pre.output);
  const results: GateResult[] = runGates(ctx, ref, pre.runId, gateCfgs, files);
  const disputes = role === "coder" && (pre.output as CoderOutput).testDisputes.length > 0;
  const rejected = results.filter((g, i) => !g.ok && gateCfgs[i]!.onMismatch === "reject");
  const warned = results
    .filter((g, i) => !g.ok && gateCfgs[i]!.onMismatch === "warn")
    .map((g) => `gate ${g.name} expected ${g.expect} but exit was ${g.exitCode ?? "none"} — see ${g.logFile}`);

  if (rejected.length && !disputes) {
    const { attempt, max } = mutate(ref, (s) => {
      const run = activeRun(s)!;
      run.gates.push(...results);
      run.submitAttempts.push({ at: nowIso(), ok: false, errors: rejected.map(describeGate) });
      addEvent(s, role, "gates_failed", rejected.map((g) => g.name).join(", "), run.id);
      return { attempt: run.submitAttempts.length, max: ctx.config.limits.maxSubmitAttempts };
    });
    io.err(`Submission rejected (attempt ${attempt}/${max}): gate(s) failed.`);
    for (const g of rejected) io.err(`\n--- ${describeGate(g)}\n${g.outputTail}`);
    io.err(`\nFix the cause and run \`aw ${role} submit\` again. If a protected test is wrong, report it in testDisputes instead.`);
    return EXIT.VALIDATION;
  }

  const { status, lines, runId } = mutate(ref, (s) => {
    const run = activeRun(s);
    if (!run || run.id !== pre.runId) throw new AwError("The run changed while gates were running. Run `aw sm next` / submit again.");
    run.gates.push(...results);
    run.warnings.push(...pre.warnings, ...warned);
    run.submitAttempts.push({ at: nowIso(), ok: true, errors: [] });
    run.state = "submitted";
    run.finishedAt = nowIso();
    const lines = complete(ctx, ref, s, run, pre.output);
    return { status: s.status, lines, runId: run.id };
  });

  io.out(`OK — ${role} run ${runId} submitted. Task status → ${status}.`);
  for (const l of lines) io.out(l);
  for (const g of results) io.out(`Gate ${describeGate(g)}`);
  for (const w of [...pre.warnings, ...warned]) io.out(`Warning: ${w}`);
  io.out(`\nNow end your turn with ONE line: \`${role} ${runId}: submitted — <≤15 words>\`.`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- fail

function fail(ctx: Ctx, role: Role, reason: string, io: Io): number {
  const ref = requireActiveTask(ctx);
  const runId = mutate(ref, (s) => {
    const run = activeRun(s);
    if (!run || run.role !== role || !stepForWorking(role, s.status)) throw mismatch(role, s.status, "fail");
    run.state = "failed";
    run.failReason = reason;
    run.finishedAt = nowIso();
    releaseNotes(s, run.id);
    transition(s, "BLOCKED", role, `${role} ${run.id} failed: ${reason}`);
    return run.id;
  });
  io.out(`Recorded: run ${runId} failed. Task is BLOCKED until the user decides.`);
  io.out(`Now end your turn with ONE line: \`${role} ${runId}: failed — ${reason.slice(0, 80)}\`.`);
  return EXIT.OK;
}
