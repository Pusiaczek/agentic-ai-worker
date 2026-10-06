/**
 * Reading and writing refinements: .tasks/refinements/<id>/, one directory per slice.
 * Only this module writes refinement.json; it is sealed and locked like a task's state.json (see sealed.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RefinementState } from "../schema/refinement";
import { AwError, EXIT } from "../util/errors";
import { nowIso } from "../util/fsx";
import type { Ctx } from "./project";
import { readSealed, type SealedFile, withFileLock, writeSealed } from "./sealed";

export interface RefinementRef {
  id: string;
  dir: string;
}

export const REFINEMENT_FILE = "refinement.json";
const HASH_FILE = "refinement.sha256";
const LOCK_FILE = "refinement.lock";

export const refinementsDir = (ctx: Ctx) => path.join(ctx.tasksDir, "refinements");

export const refinementRef = (ctx: Ctx, id: string): RefinementRef => ({ id, dir: path.join(refinementsDir(ctx), id) });

export const refinementPaths = (ref: RefinementRef) => ({
  state: path.join(ref.dir, REFINEMENT_FILE),
  input: path.join(ref.dir, "input.md"),
  briefing: path.join(ref.dir, "briefing.md"),
  /** The only file the product owner may write. */
  proposal: path.join(ref.dir, "proposal.json"),
  proposalView: path.join(ref.dir, "proposal.md"),
  revisions: path.join(ref.dir, "revisions"),
  items: path.join(ref.dir, "items"),
});

function sealedRefinement(ref: RefinementRef): SealedFile<RefinementState> {
  return {
    file: path.join(ref.dir, REFINEMENT_FILE),
    hash: path.join(ref.dir, HASH_FILE),
    lock: path.join(ref.dir, LOCK_FILE),
    schema: RefinementState,
    label: `refinement ${ref.id}`,
    fileName: REFINEMENT_FILE,
    tamperedHint: "Only the aw CLI may write refinement.json. Undo the manual edit, or cancel the refinement and start a new one.",
  };
}

export function listRefinements(ctx: Ctx): RefinementRef[] {
  const dir = refinementsDir(ctx);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, REFINEMENT_FILE)))
    .map((entry) => refinementRef(ctx, entry.name))
    .sort((first, second) => first.id.localeCompare(second.id));
}

export function requireRefinement(ctx: Ctx, id: string | undefined, usage: string): RefinementRef {
  if (!id) throw new AwError("Missing the refinement id.", EXIT.USAGE, `Usage: ${usage}`);
  const ref = refinementRef(ctx, id);
  if (!fs.existsSync(path.join(ref.dir, REFINEMENT_FILE))) {
    throw new AwError(`No refinement "${id}".`, EXIT.USAGE, "`aw refine show` lists the refinements.");
  }
  return ref;
}

export function readRefinement(ref: RefinementRef): RefinementState {
  return readSealed(sealedRefinement(ref));
}

export function writeRefinement(ref: RefinementRef, state: RefinementState): void {
  state.updatedAt = nowIso();
  writeSealed(sealedRefinement(ref), state);
}

/** Read → change in place → validate → write, under the lock. If `fn` throws, nothing is written. */
export function mutateRefinement<T>(ref: RefinementRef, fn: (state: RefinementState) => T): T {
  return withFileLock(path.join(ref.dir, LOCK_FILE), `Refinement ${ref.id}`, () => {
    const state = readRefinement(ref);
    const result = fn(state);
    writeRefinement(ref, state);
    return result;
  });
}

/**
 * The refinement a product-owner agent is working on (status WORKING), if any.
 * There is at most one: `aw refine start-agent` refuses to start a second, so hooks and
 * `aw refine submit` know which refinement the agent works on without being told.
 */
export function findWorkingRefinement(ctx: Ctx): { ref: RefinementRef; state: RefinementState } | null {
  for (const ref of listRefinements(ctx)) {
    const state = readRefinement(ref);
    if (state.status === "WORKING") return { ref, state };
  }
  return null;
}
