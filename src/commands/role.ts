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
import { RoleAction } from "../schema/commands";
import { type Gate, GateMismatchPolicy } from "../schema/config";
import { type CoderOutput, INPUT_SCHEMAS, type ReviewerOutput, ReviewVerdict, type TesterOutput } from "../schema/outputs";
import { type GateResult, type Run, RunState, TaskEventName, type TaskState } from "../schema/state";
import { Actor, Mode, ReviewTarget, Role, ROLE_STEPS, Status, stepForReady, stepForWorking } from "../schema/status";
import { parseArgs, requireStr } from "../util/args";
import { AwError, EXIT } from "../util/errors";
import { ensureDir, fileSha256, nowIso } from "../util/fsx";
import { formatIssues } from "../util/zod";

export function roleCommand(role: Role, argv: string[], io: Io): number {
  const [word, ...rest] = argv;
  const action = RoleAction.safeParse(word);
  if (!action.success) {
    throw new AwError(word ? `Unknown command: aw ${role} ${word}` : `Missing command.`, EXIT.USAGE, `Usage: aw ${role} start | submit | fail --reason "<why>"`);
  }
  const ctx = loadCtx(io.cwd);
  switch (action.data) {
    case RoleAction.enum.start: return start(ctx, role, io);
    case RoleAction.enum.submit: return submit(ctx, role, io);
    case RoleAction.enum.fail: return fail(ctx, role, requireStr(parseArgs(rest), "reason", `aw ${role} fail --reason "<why>"`), io);
  }
}

function mismatch(role: Role, status: Status | null, action: RoleAction): AwError {
  const allowed = ROLE_STEPS[role].map((s) => (action === RoleAction.enum.start ? s.ready : s.working)).join(" or ");
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
  if (!ref) throw mismatch(role, null, RoleAction.enum.start);
  const { s, run } = mutate(ref, (s) => {
    const step = stepForReady(role, s.status);
    if (!step) throw mismatch(role, s.status, RoleAction.enum.start);
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
      role === Role.enum.reviewer ? { role, target: step.target!, ...base }
      : role === Role.enum.tester ? { role, ...base }
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
    if (!run || run.role !== role || !stepForWorking(role, s.status)) throw mismatch(role, s.status, RoleAction.enum.submit);
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
        run.role === Role.enum.tester ? checkTester(ctx, s, run, output as TesterOutput)
        : run.role === Role.enum.coder ? checkCoder(ctx, s, run, output as CoderOutput)
        : checkReviewer(ctx, s, run, output as ReviewerOutput);
      errors.push(...check.errors);
      warnings = check.warnings;
    }
    if (errors.length || !output) {
      run.submitAttempts.push({ at: nowIso(), ok: false, errors });
      addEvent(s, role, TaskEventName.enum.submit_rejected, `${errors.length} error(s)`, run.id);
      writeState(ref, s);
      return { ok: false, errors, attempt: run.submitAttempts.length, max, outputFile: run.outputFile };
    }
    return { ok: true, runId: run.id, output, warnings, state: s };
  });
}

const unique = (xs: string[]) => [...new Set(xs)];

function gatesFor(ctx: Ctx, role: Role, s: TaskState, output: Output): { gates: Gate[]; files: string[] } {
  if (role === Role.enum.tester) {
    const o = output as TesterOutput;
    return { gates: ctx.config.gates.afterTests, files: unique([...o.tests.map((t) => t.file)]) };
  }
  if (role === Role.enum.coder) {
    const o = output as CoderOutput;
    const files = s.mode === Mode.enum.tdd ? protectedTests(s).map((t) => t.file) : [];
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
  addEvent(s, Actor.enum.reviewer, TaskEventName.enum.tests_protected, `${files.length} file(s) snapshotted`);
}

/** Store the output with CLI-assigned ids and move the task to its next status. */
function complete(ctx: Ctx, ref: TaskRef, s: TaskState, run: Run, output: Output): string[] {
  const limits = ctx.config.limits;
  const lines: string[] = [];
  if (run.role === Role.enum.tester) {
    const o = output as TesterOutput;
    run.output = { ...o, tests: o.tests.map((t) => ({ ...t, id: nextId(s, "test", "T") })) };
    transition(s, Status.enum.READY_FOR_TEST_REVIEW, Actor.enum.tester, `run ${run.id} submitted`);
    lines.push(`Tests registered: ${run.output.tests.map((t) => t.id).join(", ")}`);
  } else if (run.role === Role.enum.reviewer) {
    const o = output as ReviewerOutput;
    run.output = { ...o, findings: o.findings.map((f) => ({ ...f, id: nextId(s, "finding", "F") })) };
    const approved = o.verdict === ReviewVerdict.enum.approve;
    if (run.target === ReviewTarget.enum.tests) {
      const done = submittedRuns(s, Role.enum.tester).length;
      if (approved) {
        snapshotProtected(ctx, ref, s);
        transition(s, Status.enum.READY_FOR_CODING, Actor.enum.reviewer, "tests approved");
      } else if (done >= limits.maxTestIterations) {
        const reason = `tests still need changes after ${done} tester iteration(s) (limit ${limits.maxTestIterations})`;
        transition(s, Status.enum.BLOCKED, Actor.enum.reviewer, reason);
      } else transition(s, Status.enum.READY_FOR_TESTS, Actor.enum.reviewer, "changes requested on tests");
    } else {
      const done = submittedRuns(s, Role.enum.coder).length;
      if (approved) {
        const afterApproval = ctx.config.flow.docsCheck ? Status.enum.DOCS_CHECK : Status.enum.AWAITING_ACCEPTANCE;
        transition(s, afterApproval, Actor.enum.reviewer, "code approved");
      } else if (done >= limits.maxCodeIterations) {
        const reason = `code still needs changes after ${done} coder iteration(s) (limit ${limits.maxCodeIterations})`;
        transition(s, Status.enum.BLOCKED, Actor.enum.reviewer, reason);
      } else transition(s, Status.enum.READY_FOR_CODING, Actor.enum.reviewer, "changes requested on code");
    }
    if (run.output.findings.length) lines.push(`Findings registered: ${run.output.findings.map((f) => `${f.id} (${f.severity})`).join(", ")}`);
  } else {
    const o = output as CoderOutput;
    run.output = o;
    if (o.testDisputes.length) {
      const disputes = o.testDisputes.map((dispute) => `${dispute.testId}: ${dispute.reason}`).join("; ");
      transition(s, Status.enum.BLOCKED, Actor.enum.coder, `test dispute: ${disputes}`);
    } else transition(s, Status.enum.READY_FOR_CODE_REVIEW, Actor.enum.coder, `run ${run.id} submitted`);
  }
  return lines;
}

function submit(ctx: Ctx, role: Role, io: Io): number {
  const ref = findActiveTask(ctx);
  if (!ref) throw mismatch(role, null, RoleAction.enum.submit);
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
  const disputes = role === Role.enum.coder && (pre.output as CoderOutput).testDisputes.length > 0;
  const rejected = results.filter((g, i) => !g.ok && gateCfgs[i]!.onMismatch === GateMismatchPolicy.enum.reject);
  const warned = results
    .filter((g, i) => !g.ok && gateCfgs[i]!.onMismatch === GateMismatchPolicy.enum.warn)
    .map((g) => `gate ${g.name} expected ${g.expect} but exit was ${g.exitCode ?? "none"} — see ${g.logFile}`);

  if (rejected.length && !disputes) {
    const { attempt, max } = mutate(ref, (s) => {
      const run = activeRun(s)!;
      run.gates.push(...results);
      run.submitAttempts.push({ at: nowIso(), ok: false, errors: rejected.map(describeGate) });
      addEvent(s, role, TaskEventName.enum.gates_failed, rejected.map((g) => g.name).join(", "), run.id);
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
    run.state = RunState.enum.submitted;
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
    if (!run || run.role !== role || !stepForWorking(role, s.status)) throw mismatch(role, s.status, RoleAction.enum.fail);
    run.state = RunState.enum.failed;
    run.failReason = reason;
    run.finishedAt = nowIso();
    releaseNotes(s, run.id);
    transition(s, Status.enum.BLOCKED, role, `${role} ${run.id} failed: ${reason}`);
    return run.id;
  });
  io.out(`Recorded: run ${runId} failed. Task is BLOCKED until the user decides.`);
  io.out(`Now end your turn with ONE line: \`${role} ${runId}: failed — ${reason.slice(0, 80)}\`.`);
  return EXIT.OK;
}
