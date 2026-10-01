/**
 * The per-task state file (.tasks/active/<id>/state.json). Written only by the aw CLI.
 * Nothing is ever overwritten: runs, plan revisions, notes, docs checks and history are append-only.
 */
import { z } from "zod";
import {
  AcId,
  CoderOutput,
  DocsCheckBase,
  FindingBase,
  FindingId,
  NoteId,
  PlanInput,
  RetroInput,
  ReviewerOutput,
  TestId,
  TesterOutput,
  TesterTest,
} from "./outputs";
import { Actor, Mode, ReviewTarget, Role, Status } from "./status";

const Iso = z.string().min(1);
export const RunId = z.string().regex(/^R-\d+$/);
export const TaskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "letters, digits, . _ - only");

// ---------------------------------------------------------------- history

export const Transition = z.object({
  type: z.literal("transition"),
  at: Iso,
  by: Actor,
  from: Status,
  to: Status,
  note: z.string().optional(),
});
export type Transition = z.infer<typeof Transition>;

export const HistoryEvent = z.object({
  type: z.literal("event"),
  at: Iso,
  by: Actor,
  event: z.string(),
  note: z.string().optional(),
  runId: RunId.optional(),
});
export type HistoryEvent = z.infer<typeof HistoryEvent>;

export const HistoryEntry = z.discriminatedUnion("type", [Transition, HistoryEvent]);
export type HistoryEntry = z.infer<typeof HistoryEntry>;

// ---------------------------------------------------------------- gates

export const GateResult = z.object({
  name: z.string(),
  command: z.string(),
  expect: z.enum(["pass", "fail"]),
  exitCode: z.number().int().nullable(),
  ok: z.boolean(),
  skipped: z.boolean(),
  reason: z.string().optional(),
  durationMs: z.number().int(),
  outputTail: z.string(),
  logFile: z.string().optional(),
  at: Iso,
});
export type GateResult = z.infer<typeof GateResult>;

// ---------------------------------------------------------------- stored agent outputs (with CLI-assigned ids)

export const StoredTest = TesterTest.extend({ id: TestId });
export type StoredTest = z.infer<typeof StoredTest>;
export const TesterOutputStored = TesterOutput.extend({ tests: z.array(StoredTest) });

export const StoredFinding = FindingBase.extend({ id: FindingId });
export type StoredFinding = z.infer<typeof StoredFinding>;
export const ReviewerOutputStored = ReviewerOutput.extend({ findings: z.array(StoredFinding) });

// ---------------------------------------------------------------- runs

const SubmitAttempt = z.object({ at: Iso, ok: z.boolean(), errors: z.array(z.string()) });

/** One `aw test` call made during a run — to see how much time agents spend on tests. */
export const TestRun = z.object({
  at: Iso,
  durationMs: z.number().int(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean().default(false),
  files: z.number().int(),
  pattern: z.string().optional(),
  logFile: z.string().optional(),
});
export type TestRun = z.infer<typeof TestRun>;

const runCommon = {
  id: RunId,
  iteration: z.number().int().positive(),
  state: z.enum(["active", "submitted", "failed", "abandoned"]),
  startedAt: Iso,
  finishedAt: Iso.optional(),
  outputFile: z.string(),
  agentId: z.string().optional(),
  transcriptPath: z.string().optional(),
  submitAttempts: z.array(SubmitAttempt).default([]),
  testRuns: z.array(TestRun).default([]),
  gates: z.array(GateResult).default([]),
  warnings: z.array(z.string()).default([]),
  consumedNotes: z.array(NoteId).default([]),
  stopBlocks: z.number().int().default(0),
  finalMessageBlocks: z.number().int().default(0),
  stoppedWithoutSubmit: z.boolean().default(false),
  failReason: z.string().optional(),
};

export const TesterRun = z.object({ role: z.literal("tester"), ...runCommon, output: TesterOutputStored.optional() });
export const ReviewerRun = z.object({
  role: z.literal("reviewer"),
  target: ReviewTarget,
  ...runCommon,
  output: ReviewerOutputStored.optional(),
});
export const CoderRun = z.object({ role: z.literal("coder"), ...runCommon, output: CoderOutput.optional() });

export const Run = z.discriminatedUnion("role", [TesterRun, ReviewerRun, CoderRun]);
export type Run = z.infer<typeof Run>;
export type TesterRun = z.infer<typeof TesterRun>;
export type ReviewerRun = z.infer<typeof ReviewerRun>;
export type CoderRun = z.infer<typeof CoderRun>;

// ---------------------------------------------------------------- plan, notes, docs, retro

export const PlanRevision = PlanInput.omit({ acceptanceCriteria: true }).extend({
  revision: z.number().int().positive(),
  createdAt: Iso,
  acceptanceCriteria: z.array(z.object({ id: AcId, text: z.string() })),
});
export type PlanRevision = z.infer<typeof PlanRevision>;

/** Something a role must address in its next run (docs gaps, user feedback, dispute resolutions). */
export const Note = z.object({
  id: NoteId,
  forRole: Role,
  source: z.enum(["user", "scrum-master", "docs-check", "dispute", "block"]),
  text: z.string(),
  by: Actor,
  at: Iso,
  consumedByRun: RunId.optional(),
});
export type Note = z.infer<typeof Note>;

export const DocsCheck = DocsCheckBase.extend({ at: Iso });
export type DocsCheck = z.infer<typeof DocsCheck>;

export const Retro = RetroInput.extend({ at: Iso });

const AgentRef = z.object({ agentId: z.string(), at: Iso });

// ---------------------------------------------------------------- task state

export const TaskState = z.object({
  schemaVersion: z.literal(1),
  id: TaskId,
  title: z.string().min(1),
  mode: Mode,
  source: z.object({ kind: z.enum(["manual", "file", "jira"]), ref: z.string().optional() }),
  status: Status,
  blocked: z.object({ from: Status, reason: z.string(), by: Actor, at: Iso }).optional(),
  createdAt: Iso,
  updatedAt: Iso,
  git: z.object({ baseRef: z.string().nullable(), dirtyAtStart: z.boolean() }),
  plans: z.array(PlanRevision).default([]),
  approvedPlanRevision: z.number().int().optional(),
  protectedFiles: z
    .array(z.object({ path: z.string(), sha256: z.string(), snapshot: z.string() }))
    .default([]),
  runs: z.array(Run).default([]),
  notes: z.array(Note).default([]),
  docsChecks: z.array(DocsCheck).default([]),
  history: z.array(HistoryEntry).default([]),
  lastSpawn: z
    .object({ tester: AgentRef.optional(), reviewer: AgentRef.optional(), coder: AgentRef.optional() })
    .default({}),
  acceptedAt: Iso.optional(),
  retro: Retro.optional(),
  counters: z.object({
    run: z.number().int(),
    test: z.number().int(),
    finding: z.number().int(),
    note: z.number().int(),
  }),
});
export type TaskState = z.infer<typeof TaskState>;

// ---------------------------------------------------------------- backlog (aggregated follow-ups across tasks)

export const BacklogItem = z.object({
  id: z.string().regex(/^B-\d+$/),
  kind: z.enum(["followUp", "processNote", "processImprovement"]),
  text: z.string(),
  taskId: TaskId,
  runId: RunId.optional(),
  role: z.string().optional(),
  createdAt: Iso,
  status: z.enum(["open", "accepted", "ticket", "done", "rejected"]),
  note: z.string().optional(),
  updatedAt: Iso.optional(),
});
export type BacklogItem = z.infer<typeof BacklogItem>;

export const Backlog = z.object({
  schemaVersion: z.literal(1),
  counter: z.number().int(),
  items: z.array(BacklogItem),
});
export type Backlog = z.infer<typeof Backlog>;
