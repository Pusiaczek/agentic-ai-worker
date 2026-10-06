/**
 * The per-refinement state file (.tasks/refinements/<id>/refinement.json). Written only by the aw CLI.
 * A refinement splits a larger feature ("vertical slice") into small tasks before they enter the pipeline.
 * Runs, revisions, notes and history are append-only.
 */
import { z } from "zod";
import { NoteId } from "./outputs";
import { RunId, TaskId } from "./state";
import { Mode } from "./status";

const Iso = z.string().min(1);

export const RefinementId = TaskId;

/**
 * DRAFT     — waiting for (the next) proposal from the product owner;
 * WORKING   — a product-owner run is active;
 * PROPOSED  — a proposal waits for the user's decision;
 * APPROVED  — the item files are written (final);
 * CANCELLED — abandoned (final).
 */
export const RefinementStatus = z.enum(["DRAFT", "WORKING", "PROPOSED", "APPROVED", "CANCELLED"]);
export type RefinementStatus = z.infer<typeof RefinementStatus>;

export const FINAL_REFINEMENT_STATUSES: readonly RefinementStatus[] = ["APPROVED", "CANCELLED"];

export const ItemId = z.string().regex(/^I-\d+$/);

export const RefinementItem = z.object({
  id: ItemId,
  position: z.number().int().min(1),
  title: z.string(),
  goal: z.string(),
  scope: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(ItemId),
  suggestedMode: Mode,
  modeReason: z.string(),
  touches: z.array(z.string()),
  risks: z.array(z.string()),
  prerequisiteFor: z.string().optional(),
});
export type RefinementItem = z.infer<typeof RefinementItem>;

export const RefinementRevision = z.object({
  revision: z.number().int().min(1),
  runId: RunId,
  at: Iso,
  summary: z.string(),
  items: z.array(RefinementItem),
  coverage: z.array(z.object({ requirement: z.string(), items: z.array(ItemId) })),
  outOfScope: z.array(z.string()),
  openQuestions: z.array(z.string()),
  processNotes: z.array(z.string()),
  addressedNotes: z.array(z.object({ noteId: NoteId, note: z.string() })),
});
export type RefinementRevision = z.infer<typeof RefinementRevision>;

export const RefinementRun = z.object({
  id: RunId,
  state: z.enum(["active", "submitted", "abandoned"]),
  startedAt: Iso,
  finishedAt: Iso.optional(),
  agentId: z.string().optional(),
  transcriptPath: z.string().optional(),
  /** Notes this run must answer in addressedNotes, assigned when the run starts. */
  consumedNotes: z.array(NoteId),
  stopBlocks: z.number().int(),
  stoppedWithoutSubmit: z.boolean().optional(),
  abandonReason: z.string().optional(),
});
export type RefinementRun = z.infer<typeof RefinementRun>;

export const RefinementNote = z.object({
  id: NoteId,
  text: z.string(),
  at: Iso,
  consumedByRun: RunId.optional(),
});
export type RefinementNote = z.infer<typeof RefinementNote>;

export const RefinementActor = z.enum(["user", "scrum-master", "product-owner", "hook"]);
export type RefinementActor = z.infer<typeof RefinementActor>;

export const RefinementEvent = z.object({
  at: Iso,
  by: RefinementActor,
  event: z.string(),
  note: z.string().optional(),
});

export const RefinementState = z.object({
  schemaVersion: z.literal(1),
  id: RefinementId,
  title: z.string().min(1),
  source: z.object({ kind: z.enum(["manual", "file"]), ref: z.string().optional() }),
  status: RefinementStatus,
  createdAt: Iso,
  updatedAt: Iso,
  runs: z.array(RefinementRun),
  revisions: z.array(RefinementRevision),
  notes: z.array(RefinementNote),
  approvedRevision: z.number().int().min(1).optional(),
  history: z.array(RefinementEvent),
  counters: z.object({ run: z.number().int(), note: z.number().int() }),
});
export type RefinementState = z.infer<typeof RefinementState>;
