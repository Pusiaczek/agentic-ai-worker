import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE, Config } from "../schema/config";
import { AwError, EXIT } from "../util/errors";
import { toPosix } from "../util/fsx";
import { formatIssues } from "../util/zod";

export interface Ctx {
  root: string;
  config: Config;
  /** Absolute paths. */
  tasksDir: string;
  activeDir: string;
  archiveDir: string;
  roleNotesDir: string;
}

/** Walk up from `start` to the directory holding .claude/aw.config.json. */
export function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseConfig(raw: unknown, source = CONFIG_FILE): Config {
  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    const lines = formatIssues(parsed.error).map((l) => `  - ${l}`);
    throw new AwError(`Invalid ${source}:\n${lines.join("\n")}`, EXIT.VALIDATION);
  }
  return parsed.data;
}

export function loadConfig(root: string): Config {
  const file = path.join(root, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new AwError(`Cannot read ${CONFIG_FILE}: ${(e as Error).message}`, EXIT.VALIDATION);
  }
  return parseConfig(raw);
}

export function makeCtx(root: string, config: Config): Ctx {
  const tasksDir = path.resolve(root, config.paths.tasksDir);
  return {
    root,
    config,
    tasksDir,
    activeDir: path.join(tasksDir, "active"),
    archiveDir: path.resolve(root, config.paths.archiveDir),
    roleNotesDir: path.resolve(root, config.paths.roleNotesDir),
  };
}

export function loadCtx(cwd: string): Ctx {
  const root = findRoot(cwd);
  if (!root) {
    throw new AwError(
      `aw is not initialized here: no ${CONFIG_FILE} in ${cwd} or its parents.`,
      EXIT.NOT_INITIALIZED,
      "Run /aw:init in the repository root.",
    );
  }
  return makeCtx(root, loadConfig(root));
}

/** For hooks: null when the repository doesn't use aw (hooks must then stay out of the way). */
export function tryLoadCtx(cwd: string): Ctx | null {
  const root = findRoot(cwd);
  return root ? makeCtx(root, loadConfig(root)) : null;
}

/** Project-relative posix path for display and for storing in state. */
export function rel(ctx: Ctx, abs: string): string {
  return toPosix(path.relative(ctx.root, abs));
}
