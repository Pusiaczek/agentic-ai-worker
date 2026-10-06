/** State-machine operations and read helpers over TaskState. Pure: no I/O. */
import { isBlocking, PreviousFindingStatus } from "../schema/outputs";
import {
  type Note,
  type PlanRevision,
  type ReviewerRun,
  type Run,
  RunState,
  type StoredFinding,
  type StoredTest,
  type TaskEventName,
  type TaskState,
  type TesterRun,
} from "../schema/state";
import { type Actor, Mode, type ReviewTarget, Role, Status, TRANSITIONS } from "../schema/status";
import { AwError } from "../util/errors";
import { nowIso } from "../util/fsx";

export function transition(s: TaskState, to: Status, by: Actor, note?: string): void {
  const from = s.status;
  if (!TRANSITIONS[from].includes(to)) {
    throw new AwError(`Illegal transition ${from} → ${to}. Allowed from ${from}: ${TRANSITIONS[from].join(", ") || "none"}.`);
  }
  const at = nowIso();
  s.history.push({ type: "transition", at, by, from, to, ...(note ? { note } : {}) });
  if (to === Status.enum.BLOCKED) s.blocked = { from, reason: note ?? "", by, at };
  else if (from === Status.enum.BLOCKED) delete s.blocked;
  s.status = to;
}

export function addEvent(s: TaskState, by: Actor, event: TaskEventName, note?: string, runId?: string): void {
  s.history.push({ type: "event", at: nowIso(), by, event, ...(note ? { note } : {}), ...(runId ? { runId } : {}) });
}

export function nextId(s: TaskState, counter: keyof TaskState["counters"], prefix: string): string {
  s.counters[counter] += 1;
  return `${prefix}-${s.counters[counter]}`;
}

export function firstWorkStatus(mode: Mode): Status {
  return mode === Mode.enum.tdd ? Status.enum.READY_FOR_TESTS : Status.enum.READY_FOR_CODING;
}

export function currentPlan(s: TaskState): PlanRevision | undefined {
  if (s.approvedPlanRevision !== undefined) return s.plans.find((p) => p.revision === s.approvedPlanRevision);
  return s.plans.at(-1);
}

export function acIds(s: TaskState): string[] {
  return currentPlan(s)?.acceptanceCriteria.map((a) => a.id) ?? [];
}

export function runsOf(s: TaskState, role: Role, target?: ReviewTarget): Run[] {
  return s.runs.filter((r) => r.role === role && (target === undefined || (r.role === Role.enum.reviewer && r.target === target)));
}

export function submittedRuns(s: TaskState, role: Role, target?: ReviewTarget): Run[] {
  return runsOf(s, role, target).filter((r) => r.state === RunState.enum.submitted);
}

export function latestRun(s: TaskState, role: Role, target?: ReviewTarget): Run | undefined {
  return runsOf(s, role, target).at(-1);
}

export function activeRun(s: TaskState): Run | undefined {
  return s.runs.find((r) => r.state === RunState.enum.active);
}

export function latestSubmittedTester(s: TaskState): TesterRun | undefined {
  return submittedRuns(s, Role.enum.tester).at(-1) as TesterRun | undefined;
}

export function latestSubmittedReview(s: TaskState, target: ReviewTarget): ReviewerRun | undefined {
  return submittedRuns(s, Role.enum.reviewer, target).at(-1) as ReviewerRun | undefined;
}

/** Tests the coder must make pass: the latest accepted tester output. */
export function protectedTests(s: TaskState): StoredTest[] {
  return latestSubmittedTester(s)?.output?.tests ?? [];
}

export type OpenFinding = StoredFinding & { runId: string };

/**
 * Blocking findings (blocker/major) of a review target that no later review round closed.
 * A finding closes when a later review of the same target marks it fixed / no_longer_applicable.
 */
export function openBlockingFindings(s: TaskState, target: ReviewTarget): OpenFinding[] {
  const open = new Map<string, OpenFinding>();
  for (const run of submittedRuns(s, Role.enum.reviewer, target) as ReviewerRun[]) {
    if (!run.output) continue;
    for (const pf of run.output.previousFindings) {
      if (pf.status !== PreviousFindingStatus.enum.not_fixed) open.delete(pf.id);
    }
    for (const f of run.output.findings) {
      if (isBlocking(f.severity)) open.set(f.id, { ...f, runId: run.id });
    }
  }
  return [...open.values()];
}

export function pendingNotes(s: TaskState, role: Role): Note[] {
  return s.notes.filter((n) => n.forRole === role && !n.consumedByRun);
}

export function addNote(s: TaskState, forRole: Role, source: Note["source"], text: string, by: Actor): Note {
  const note: Note = { id: nextId(s, "note", "N"), forRole, source, text, by, at: nowIso() };
  s.notes.push(note);
  return note;
}

export function describeFinding(f: StoredFinding): string {
  const lines = f.line ? `:${f.line}${f.endLine ? `-${f.endLine}` : ""}` : "";
  const where = f.file ? `${f.file}${lines}${f.symbol ? ` (${f.symbol})` : ""}` : f.symbol ? `(${f.symbol})` : "whole change";
  return `${f.id} [${f.severity}/${f.category}] ${where} — ${f.message}${f.suggestion ? ` (suggestion: ${f.suggestion})` : ""}`;
}
