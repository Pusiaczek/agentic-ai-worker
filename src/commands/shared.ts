import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { z } from "zod";
import type { Ctx } from "../core/project";
import type { Io } from "../io";
import { AwError, EXIT } from "../util/errors";
import { formatIssues } from "../util/zod";

export function readInputJson(io: Io, file: string): unknown {
  const abs = path.resolve(io.cwd, file);
  if (!fs.existsSync(abs)) throw new AwError(`File not found: ${file}`, EXIT.USAGE);
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new AwError(`${file} is not valid JSON: ${(e as Error).message}`, EXIT.VALIDATION);
  }
}

export function parseInput<S extends z.ZodType>(schema: S, raw: unknown, label: string, schemaName: string): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = formatIssues(result.error).map((l) => `  - ${l}`);
    throw new AwError(`${label} does not match the schema:\n${lines.join("\n")}`, EXIT.VALIDATION, `See \`aw schema ${schemaName}\`.`);
  }
  return result.data;
}

export function gitInfo(ctx: Ctx): { baseRef: string | null; dirtyAtStart: boolean } {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: ctx.root, encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  const baseRef = head.status === 0 ? head.stdout.trim() : null;
  const status = git("status", "--porcelain");
  const tasksPrefix = ctx.config.paths.tasksDir.replace(/^\.\//, "");
  const dirty =
    status.status === 0 &&
    status.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .some((l) => !l.slice(3).startsWith(tasksPrefix));
  return { baseRef, dirtyAtStart: dirty };
}

export function list(items: string[], indent = "  - "): string {
  return items.map((i) => `${indent}${i}`).join("\n");
}
