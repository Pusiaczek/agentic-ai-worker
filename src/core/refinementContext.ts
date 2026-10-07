/**
 * What the product owner gets besides the slice description:
 * - the project documentation it reads in full before every split (refine.contextDocs);
 * - the work already planned or done (other refinements, the active task, archived tasks),
 *   so it neither plans that work again nor contradicts it.
 */
import { RefinementStatus, type RefinementState } from "../schema/refinement";
import type { TaskState } from "../schema/state";
import { listFiles } from "../util/fsx";
import { globMatcher } from "../util/glob";
import type { Ctx } from "./project";
import { listRefinements, readRefinement, type RefinementRef } from "./refinementStore";
import { findActiveTask, readArchivedTasks, readState } from "./store";

/** The files matched by refine.contextDocs, sorted, as paths relative to the repository root. */
export function contextDocFiles(ctx: Ctx): string[] {
  const isContextDoc = globMatcher(ctx.config.refine.contextDocs);
  return listFiles(ctx.root).filter(isContextDoc).sort();
}

export interface PlannedWork {
  /** Refinements other than the current one, except cancelled ones. */
  refinements: { ref: RefinementRef; state: RefinementState }[];
  activeTask: TaskState | null;
  archivedTasks: TaskState[];
}

/** The value, or null when its file can't be read: a broken file elsewhere must not block the split. */
function readOrNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** Everything planned or done outside the refinement `currentId`. */
export function plannedWork(ctx: Ctx, currentId: string): PlannedWork {
  const refinements: PlannedWork["refinements"] = [];
  for (const ref of listRefinements(ctx)) {
    if (ref.id === currentId) continue;
    const state = readOrNull(() => readRefinement(ref));
    if (state && state.status !== RefinementStatus.enum.CANCELLED) refinements.push({ ref, state });
  }
  const activeRef = readOrNull(() => findActiveTask(ctx));
  const activeTask = activeRef ? readOrNull(() => readState(activeRef)) : null;
  return { refinements, activeTask, archivedTasks: readArchivedTasks(ctx).tasks };
}
