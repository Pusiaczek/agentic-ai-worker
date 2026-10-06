/** Operations and read helpers over RefinementState. Pure: no I/O. */
import type { RefineOutput } from "../schema/outputs";
import type {
  RefinementActor,
  RefinementNote,
  RefinementRevision,
  RefinementRun,
  RefinementState,
  RefinementStatus,
} from "../schema/refinement";
import { AwError, EXIT } from "../util/errors";
import { nowIso } from "../util/fsx";

export const INPUT_PLACEHOLDER =
  "<!-- aw: paste the slice description here VERBATIM, exactly as the user / ticket gave it. Do not summarize or rephrase. -->\n";

/** The slice text without template comments; empty until someone writes it. */
export function writtenInput(text: string | null): string {
  return (text ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function addRefinementEvent(s: RefinementState, by: RefinementActor, event: string, note?: string): void {
  s.history.push({ at: nowIso(), by, event, ...(note ? { note } : {}) });
}

export function nextRefinementId(s: RefinementState, counter: keyof RefinementState["counters"], prefix: string): string {
  s.counters[counter] += 1;
  return `${prefix}-${s.counters[counter]}`;
}

/** Refuses the action unless the refinement is in one of the `allowed` statuses. */
export function requireStatus(s: RefinementState, allowed: readonly RefinementStatus[], action: string): void {
  if (!allowed.includes(s.status)) {
    throw new AwError(
      `Refinement ${s.id} is ${s.status}; "${action}" needs ${allowed.join(" or ")}.`,
      EXIT.STATUS_MISMATCH,
      `See \`aw refine next ${s.id}\`.`,
    );
  }
}

export function activeRefinementRun(s: RefinementState): RefinementRun | undefined {
  return s.runs.find((run) => run.state === "active");
}

/** Notes no run has taken yet: the next product-owner run must answer them. */
export function pendingRefinementNotes(s: RefinementState): RefinementNote[] {
  return s.notes.filter((note) => !note.consumedByRun);
}

export function latestRevision(s: RefinementState): RefinementRevision | undefined {
  return s.revisions.at(-1);
}

/** Ends the active run without a proposal; its notes go back to the queue for the next run. */
export function abandonActiveRun(s: RefinementState, reason: string): void {
  const run = activeRefinementRun(s);
  if (!run) return;
  run.state = "abandoned";
  run.finishedAt = nowIso();
  run.abandonReason = reason;
  for (const note of s.notes) if (note.consumedByRun === run.id) delete note.consumedByRun;
}

/** "I-n" for the item at 1-based position n of a proposal. */
export const itemIdAt = (position: number) => `I-${position}`;

/** A validated proposal as a stored revision: positions become item IDs. */
export function toRevision(s: RefinementState, run: RefinementRun, out: RefineOutput): RefinementRevision {
  return {
    revision: s.revisions.length + 1,
    runId: run.id,
    at: nowIso(),
    summary: out.summary,
    items: out.items.map((item, index) => ({
      id: itemIdAt(index + 1),
      position: index + 1,
      title: item.title,
      goal: item.goal,
      scope: item.scope,
      acceptanceCriteria: item.acceptanceCriteria,
      dependsOn: item.dependsOn.map(itemIdAt),
      suggestedMode: item.suggestedMode,
      modeReason: item.modeReason,
      touches: item.touches,
      risks: item.risks,
      ...(item.prerequisiteFor ? { prerequisiteFor: item.prerequisiteFor } : {}),
    })),
    coverage: out.coverage.map((entry) => ({ requirement: entry.requirement, items: entry.items.map(itemIdAt) })),
    outOfScope: out.outOfScope,
    openQuestions: out.openQuestions,
    processNotes: out.processNotes,
    addressedNotes: out.addressedNotes,
  };
}
