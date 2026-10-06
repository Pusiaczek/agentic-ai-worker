/**
 * JSON files only the aw CLI writes (state.json of a task, refinement.json of a refinement):
 * - every write is validated against the schema and atomic;
 * - every write is paired with a sha256 "seal", so an edit made outside the CLI is detected on the next read;
 * - read-change-write runs under a lock file in the same directory.
 */
import * as fs from "node:fs";
import type { z } from "zod";
import { AwError, EXIT } from "../util/errors";
import { readTextIfExists, sha256, sleepSync, writeFileAtomic } from "../util/fsx";
import { formatIssues } from "../util/zod";

const STALE_LOCK_MS = 60_000;

export interface SealedFile<T> {
  /** Absolute paths of the JSON file, its seal and its lock file. */
  file: string;
  hash: string;
  lock: string;
  schema: z.ZodType<T>;
  /** Names the file in messages, e.g. "task 2026-10-06-login". */
  label: string;
  /** File name in messages, e.g. "state.json". */
  fileName: string;
  /** Shown when the seal doesn't match: what the user can do about it. */
  tamperedHint: string;
}

/** Parses the file's text against its schema; `label` names it in error messages. */
export function parseSealedText<T>(schema: z.ZodType<T>, fileName: string, text: string, label: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new AwError(`${label}: ${fileName} is not valid JSON: ${(e as Error).message}`, EXIT.TAMPERED);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = formatIssues(parsed.error).map((line) => `  - ${line}`);
    throw new AwError(`${label}: ${fileName} does not match the schema:\n${lines.join("\n")}`, EXIT.TAMPERED);
  }
  return parsed.data;
}

export function readSealed<T>(sealed: SealedFile<T>, opts: { verifyHash?: boolean } = {}): T {
  const text = fs.readFileSync(sealed.file, "utf8");
  if (opts.verifyHash !== false) {
    const expected = readTextIfExists(sealed.hash)?.trim();
    if (expected !== sha256(text)) {
      throw new AwError(
        `${sealed.fileName} of ${sealed.label} was modified outside the aw CLI (hash mismatch).`,
        EXIT.TAMPERED,
        sealed.tamperedHint,
      );
    }
  }
  return parseSealedText(sealed.schema, sealed.fileName, text, sealed.label);
}

export function writeSealed<T>(sealed: SealedFile<T>, value: T): void {
  const checked = sealed.schema.parse(value); // a failure here is a bug in the CLI, not user error
  const text = `${JSON.stringify(checked, null, 2)}\n`;
  writeFileAtomic(sealed.file, text);
  writeFileAtomic(sealed.hash, `${sha256(text)}\n`);
}

/** Runs `fn` while holding `lockFile`. A lock older than a minute is treated as left over by a crashed process. */
export function withFileLock<T>(lockFile: string, label: string, fn: () => T, timeoutMs = 15_000): T {
  const started = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between the failed create and stat
      }
      if (Date.now() - started > timeoutMs) {
        throw new AwError(`${label} is locked by another aw process (${lockFile}).`);
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}
