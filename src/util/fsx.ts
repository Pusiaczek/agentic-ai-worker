import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function fileSha256(file: string): string | null {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write via temp file + rename so readers never see a half-written file. */
export function writeFileAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Project-relative posix path, or null when the path is outside the project. */
export function relativeToRoot(root: string, file: string, cwd: string = root): string | null {
  const abs = path.resolve(cwd, file);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

export function readTextIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/g, "") || "task";
}

export function today(): string {
  return nowIso().slice(0, 10);
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…(truncated)…\n${text.slice(text.length - maxChars)}`;
}
