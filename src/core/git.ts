import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readTextIfExists } from "../util/fsx";

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

/** Repository root, or `cwd` when not inside a git repository. */
export function gitRoot(cwd: string): string {
  const r = git(cwd, "rev-parse", "--show-toplevel");
  return r.status === 0 ? path.resolve(r.stdout.trim()) : cwd;
}

/**
 * Files changed since `baseRef` (tracked, working tree) plus untracked, non-ignored files —
 * posix paths relative to `root`. Empty outside a git repository.
 */
export function changedFiles(root: string, baseRef: string | null): string[] {
  const out = new Set<string>();
  const add = (stdout: string) => {
    for (const line of stdout.split(/\r?\n/)) if (line.trim()) out.add(line.trim().replace(/\\/g, "/"));
  };
  if (baseRef) {
    const diff = git(root, "diff", "--name-only", "--relative", baseRef);
    if (diff.status === 0) add(diff.stdout);
  }
  const untracked = git(root, "ls-files", "--others", "--exclude-standard");
  if (untracked.status === 0) add(untracked.stdout);
  return [...out];
}

/** The repository's local-only ignore file (.git/info/exclude, worktree-aware), or null outside git. */
export function excludeFile(root: string): string | null {
  const r = git(root, "rev-parse", "--git-path", "info/exclude");
  return r.status === 0 ? path.resolve(root, r.stdout.trim()) : null;
}

/** true/false = ignored by any git ignore source; null = not a git repository. */
export function isIgnored(root: string, relPath: string): boolean | null {
  const r = git(root, "check-ignore", "-q", "--no-index", relPath);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

const BEGIN = "# >>> aw local mode — managed by `aw init` (`aw init --shared` removes this block)";
const END = "# <<< aw";
const BLOCK = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END}\\n?`, "g");

/** Replace (or remove, when `entries` is null) the aw block in an ignore file. Returns whether the file changed. */
export function setManagedBlock(file: string, entries: string[] | null): boolean {
  const before = readTextIfExists(file) ?? "";
  let text = before.replace(BLOCK, "\n").replace(/\n{3,}$/, "\n\n");
  if (entries) {
    if (text && !text.endsWith("\n")) text += "\n";
    text += `${BEGIN}\n${entries.join("\n")}\n${END}\n`;
  }
  if (text === before) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return true;
}

/** Append a line to a .gitignore-style file unless an equivalent line is present. */
export function ensureIgnoreLine(file: string, entry: string, comment: string): boolean {
  const text = readTextIfExists(file) ?? "";
  const bare = entry.replace(/^\//, "");
  if (text.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === bare)) return false;
  fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# ${comment}\n${entry}\n`);
  return true;
}
