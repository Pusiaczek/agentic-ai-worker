/**
 * `aw init` — deterministic part of onboarding a repository: detect commands, write the config,
 * its JSON Schema, role-note templates, and hide aw's files from git (local mode, default) or
 * ignore only the task traces (--shared). The /aw:init skill does the judgment part
 * (filling the templates, the docs index, CLAUDE.local.md / CLAUDE.md) on top of this.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ensureIgnoreLine, excludeFile, gitRoot, setManagedBlock } from "../core/git";
import { templatesDir } from "../core/pluginFiles";
import { parseConfig } from "../core/project";
import type { Io } from "../io";
import { CONFIG_FILE, Config } from "../schema/config";
import { bool, parseArgs, str } from "../util/args";
import { EXIT } from "../util/errors";
import { ensureDir, readTextIfExists, toPosix, writeFileAtomic } from "../util/fsx";

/** Templates copied into `.claude/aw/`: notes per role, plus repository code standards shared by all agents. */
const REPO_NOTE_FILES = ["coder", "tester", "reviewer", "scrum-master", "code-standards"];

interface Detected {
  commands: Record<string, string>;
  gates: { afterTests: unknown[]; afterCoding: unknown[] };
  docs: { path: string; when: string }[];
  notes: string[];
}

function detect(root: string): Detected {
  const notes: string[] = [];
  const pkgText = readTextIfExists(path.join(root, "package.json"));
  const pkg = pkgText ? JSON.parse(pkgText) : null;
  if (!pkg) notes.push("no package.json — fill `commands` by hand");
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const deps: Record<string, string> = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
  const run = (script: string) => (pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`);
  const pick = (...names: string[]) => names.find((n) => n in scripts);

  const commands: Record<string, string> = {};
  if (scripts.test && !/no test specified/.test(scripts.test)) commands.test = pm === "npm" ? "npm test" : `${pm} test`;
  const lint = pick("lint");
  if (lint) commands.lint = run(lint);
  const typecheck = pick("typecheck", "type-check", "check-types", "types", "tsc");
  if (typecheck) commands.typecheck = run(typecheck);
  else if (has("tsconfig.json")) commands.typecheck = "npx tsc --noEmit";
  const e2e = pick("test:e2e", "e2e");
  if (e2e) commands.e2e = run(e2e);

  // `aw test -t "<name>"` appends `-t` (vitest, jest); runners with another flag get commands.testFiltered.
  if (deps.vitest) commands.testFiles = "npx vitest run {files}";
  else if (deps.jest) commands.testFiles = "npx jest {files}";
  else if (deps.mocha) {
    commands.testFiles = "npx mocha {files}";
    commands.testFiltered = "npx mocha {files} --grep {pattern}";
  } else if (/node\s+--test/.test(scripts.test ?? "")) {
    commands.testFiles = "node --test {files}";
    commands.testFiltered = "node --test --test-name-pattern {pattern} {files}";
  } else notes.push("test runner not recognized — set commands.testFiles (use {files} for the file list); `aw test` and the TDD red check need it");

  const afterTests = commands.testFiles ? [{ run: "testFiles", expect: "fail", onMismatch: "warn" }] : [];
  const afterCoding = ["lint", "typecheck", commands.test ? "test" : "testFiles"]
    .filter((k) => k in commands)
    .map((k) => ({ run: k, expect: "pass", onMismatch: "reject" }));
  if (!commands.test) notes.push("no `test` script — the coder gate runs only the task's test files");

  const docs: { path: string; when: string }[] = [];
  if (has("README.md")) docs.push({ path: "README.md", when: "TODO: e.g. setup, usage or configuration changes" });
  const docsDir = path.join(root, "docs");
  if (fs.existsSync(docsDir)) {
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (found.length >= 15) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 2) walk(p, depth + 1);
        else if (e.isFile() && /\.mdx?$/.test(e.name)) found.push(toPosix(path.relative(root, p)));
      }
    };
    walk(docsDir, 0);
    for (const f of found) docs.push({ path: f, when: "TODO: when should an agent read / update this?" });
    if (found.length >= 15) notes.push("docs/ has more files than listed — the docs index covers the first 15; curate it");
  }
  return { commands, gates: { afterTests, afterCoding }, docs, notes };
}

const asIgnoreEntry = (p: string, dir: boolean) => `/${p.replace(/^\.\//, "").replace(/\/$/, "")}${dir ? "/" : ""}`;

/** Task state, traces and archive — never committed in either mode. */
function traceEntries(cfg: Config): string[] {
  const tasks = asIgnoreEntry(cfg.paths.tasksDir, true);
  const archive = asIgnoreEntry(cfg.paths.archiveDir, true);
  return archive.startsWith(tasks) ? [tasks] : [tasks, archive];
}

/** Everything aw adds to a repository — hidden from git in local mode. */
function localEntries(cfg: Config): string[] {
  return [
    ...traceEntries(cfg),
    asIgnoreEntry(CONFIG_FILE, false),
    "/.claude/aw.config.schema.json",
    asIgnoreEntry(cfg.paths.roleNotesDir, true),
    "/.claude/settings.local.json",
    "/CLAUDE.local.md",
  ];
}

/**
 * local (default): nothing aw creates is visible to git — entries go to .git/info/exclude, which is never committed.
 * shared (--shared): the config and role notes are meant to be committed; only task traces are ignored via .gitignore.
 */
function applySharingMode(root: string, cfg: Config, shared: boolean, report: string[]): void {
  const exclude = excludeFile(root);
  if (shared) {
    if (exclude && setManagedBlock(exclude, null)) report.push("removed the aw block from .git/info/exclude");
    const gitignore = path.join(root, ".gitignore");
    for (const entry of traceEntries(cfg)) {
      if (ensureIgnoreLine(gitignore, entry, "aw task state, traces and archive")) report.push(`added ${entry} to .gitignore`);
    }
    report.push("mode: shared — commit .claude/aw.config.json, .claude/aw.config.schema.json and .claude/aw/; .tasks/ stays local");
    return;
  }
  if (!exclude) {
    report.push("mode: local — WARNING: not a git repository, nothing to hide from git");
    return;
  }
  setManagedBlock(exclude, localEntries(cfg));
  report.push(`mode: local ("ghost") — aw files are hidden from git via ${toPosix(path.relative(root, exclude))}; .gitignore untouched`);
}

export function initCommand(argv: string[], io: Io): number {
  const args = parseArgs(argv, ["force", "shared", "local"]);
  const shared = bool(args, "shared");
  const root = gitRoot(io.cwd);
  const configPath = path.join(root, CONFIG_FILE);
  const templates = templatesDir(io.env);
  const report: string[] = [];

  const exists = fs.existsSync(configPath);
  let cfg: Config;
  if (exists && !bool(args, "force")) {
    cfg = parseConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
    report.push(`config exists: ${CONFIG_FILE} (kept; --force regenerates it)`);
  } else {
    const d = detect(root);
    const raw = {
      $schema: "./aw.config.schema.json",
      version: 1,
      language: str(args, "language") ?? "en",
      commands: d.commands,
      gates: d.gates,
      docs: d.docs,
    };
    cfg = parseConfig(raw, "detected config");
    writeFileAtomic(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    report.push(`wrote ${CONFIG_FILE}`);
    report.push(...Object.entries(d.commands).map(([k, v]) => `  commands.${k} = ${v}`));
    report.push(...d.notes.map((n) => `  NOTE: ${n}`));
  }
  const schemaPath = path.join(root, ".claude", "aw.config.schema.json");
  writeFileAtomic(schemaPath, `${JSON.stringify(z.toJSONSchema(Config, { io: "input", unrepresentable: "any" }), null, 2)}\n`);
  report.push("wrote .claude/aw.config.schema.json (editor autocomplete for the config)");

  const notesDir = path.resolve(root, cfg.paths.roleNotesDir);
  ensureDir(notesDir);
  for (const name of REPO_NOTE_FILES) {
    const target = path.join(notesDir, `${name}.md`);
    const shown = toPosix(path.relative(root, target));
    if (fs.existsSync(target)) {
      report.push(`kept ${shown}`);
      continue;
    }
    fs.copyFileSync(path.join(templates, "role-notes", `${name}.md`), target);
    report.push(`created ${shown} (template — fill it in)`);
  }

  applySharingMode(root, cfg, shared, report);

  const has = (f: string) => fs.existsSync(path.join(root, f));
  const instructions = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"].filter(has);
  report.push(`project instructions found: ${instructions.length ? instructions.join(", ") : "none"}`);
  report.push(`instruction file for aw additions: ${shared ? "CLAUDE.md" : "CLAUDE.local.md (loaded after CLAUDE.md, never committed)"}`);
  report.push(`CLAUDE.md sections template: ${toPosix(path.join(templates, "CLAUDE.section.md"))}`);

  io.out(`aw init in ${root}`);
  io.out(report.map((r) => (r.startsWith("  ") ? r : `- ${r}`)).join("\n"));
  io.out("\nNext: fill the TODOs (docs index `when`, role notes), then run `aw doctor`.");
  return EXIT.OK;
}
