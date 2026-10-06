/**
 * Reading and writing task state. Invariants:
 * - only this module writes state.json;
 * - every write is validated against the schema, atomic, and paired with state.sha256,
 *   so an edit made outside the CLI is detected on the next read (see sealed.ts);
 * - mutations run under a lock file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Backlog, TaskState } from "../schema/state";
import { AwError, EXIT } from "../util/errors";
import { nowIso, readTextIfExists, writeFileAtomic } from "../util/fsx";
import { formatIssues } from "../util/zod";
import type { Ctx } from "./project";
import { parseSealedText, readSealed, type SealedFile, withFileLock, writeSealed } from "./sealed";

export interface TaskRef {
  id: string;
  dir: string;
}

export const STATE_FILE = "state.json";
const HASH_FILE = "state.sha256";
const LOCK_FILE = "state.lock";

export const taskPaths = (ref: TaskRef) => ({
  state: path.join(ref.dir, STATE_FILE),
  hash: path.join(ref.dir, HASH_FILE),
  requirements: path.join(ref.dir, "requirements.md"),
  plan: path.join(ref.dir, "plan.md"),
  report: path.join(ref.dir, "report.md"),
  out: path.join(ref.dir, "out"),
  logs: path.join(ref.dir, "logs"),
  protected: path.join(ref.dir, "protected"),
});

function sealedState(ref: TaskRef): SealedFile<TaskState> {
  return {
    file: path.join(ref.dir, STATE_FILE),
    hash: path.join(ref.dir, HASH_FILE),
    lock: path.join(ref.dir, LOCK_FILE),
    schema: TaskState,
    label: `task ${ref.id}`,
    fileName: STATE_FILE,
    tamperedHint:
      "Only the aw CLI may write state.json. If the edit was intended, the orchestrator can accept it with `aw sm repair` (requires user confirmation).",
  };
}

export function listActive(ctx: Ctx): TaskRef[] {
  if (!fs.existsSync(ctx.activeDir)) return [];
  return fs
    .readdirSync(ctx.activeDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ctx.activeDir, d.name, STATE_FILE)))
    .map((d) => ({ id: d.name, dir: path.join(ctx.activeDir, d.name) }));
}

export function findActiveTask(ctx: Ctx): TaskRef | null {
  const active = listActive(ctx);
  if (active.length > 1) {
    throw new AwError(`More than one active task (${active.map((t) => t.id).join(", ")}). aw supports one at a time.`);
  }
  return active[0] ?? null;
}

export function requireActiveTask(ctx: Ctx): TaskRef {
  const ref = findActiveTask(ctx);
  if (!ref) throw new AwError("No active task.", EXIT.ERROR, "The orchestrator starts one with `aw sm new`.");
  return ref;
}

export function parseStateText(text: string, label: string): TaskState {
  return parseSealedText(TaskState, STATE_FILE, text, label);
}

export function readState(ref: TaskRef, opts: { verifyHash?: boolean } = {}): TaskState {
  return readSealed(sealedState(ref), opts);
}

export function writeState(ref: TaskRef, state: TaskState): void {
  state.updatedAt = nowIso();
  writeSealed(sealedState(ref), state);
}

export function withLock<T>(ref: TaskRef, fn: () => T, timeoutMs = 15_000): T {
  return withFileLock(path.join(ref.dir, LOCK_FILE), `Task ${ref.id}`, fn, timeoutMs);
}

/** Read → change in place → validate → write, under the lock. If `fn` throws, nothing is written. */
export function mutate<T>(ref: TaskRef, fn: (state: TaskState) => T): T {
  return withLock(ref, () => {
    const state = readState(ref);
    const result = fn(state);
    writeState(ref, state);
    return result;
  });
}

// ---------------------------------------------------------------- backlog

export function backlogPath(ctx: Ctx): string {
  return path.join(ctx.tasksDir, "backlog.json");
}

export function readBacklog(ctx: Ctx): Backlog {
  const text = readTextIfExists(backlogPath(ctx));
  if (!text) return { schemaVersion: 1, counter: 0, items: [] };
  const parsed = Backlog.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new AwError(`backlog.json does not match the schema:\n${formatIssues(parsed.error).join("\n")}`);
  }
  return parsed.data;
}

export function writeBacklog(ctx: Ctx, backlog: Backlog): void {
  writeFileAtomic(backlogPath(ctx), `${JSON.stringify(Backlog.parse(backlog), null, 2)}\n`);
}
