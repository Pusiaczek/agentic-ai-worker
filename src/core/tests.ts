/** Which test files belong to the task, and the command that runs them — shared by `aw test` and the guards. */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Config, DirectTestCommands } from "../schema/config";
import type { TaskState } from "../schema/state";
import { Role } from "../schema/status";
import { AwError, EXIT } from "../util/errors";
import { globMatcher } from "../util/glob";
import { quoteArg, quoteFile } from "./gates";
import { changedFiles } from "./git";
import { latestSubmittedTester } from "./machine";
import type { Ctx } from "./project";

/** Test specs by the usual naming convention; helpers and fixtures in test dirs don't match. */
const SPEC_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * This task's test files: approved (protected) tests, the tester's and the coder's declared tests,
 * and test files created or changed in the working tree since the task started.
 */
export function taskTestFiles(ctx: Ctx, s: TaskState): string[] {
  const isTestPath = globMatcher(ctx.config.tests.globs);
  const candidates = new Set<string>(s.protectedFiles.map((p) => p.path));
  for (const t of latestSubmittedTester(s)?.output?.tests ?? []) candidates.add(t.file);
  for (const r of s.runs) if (r.role === Role.enum.coder && r.output) for (const t of r.output.testsAdded) candidates.add(t.file);
  for (const f of changedFiles(ctx.root, s.git.baseRef)) if (isTestPath(f)) candidates.add(f);
  const existing = [...candidates].filter((f) => fs.existsSync(path.join(ctx.root, f)));
  const specs = existing.filter((f) => SPEC_FILE.test(f));
  return (specs.length ? specs : existing).sort();
}

/** `commands.testFiles` with the files filled in; a name filter via `commands.testFiltered` or a trailing `-t`. */
export function buildTestCommand(config: Config, files: string[], pattern?: string): string {
  const template = config.commands.testFiles;
  if (!template) {
    throw new AwError(
      "commands.testFiles is not configured, so `aw test` doesn't know how to run test files.",
      EXIT.USAGE,
      'Add it to .claude/aw.config.json, e.g. "testFiles": "npx vitest run {files}".',
    );
  }
  const fileList = files.map(quoteFile).join(" ");
  const withFiles = (t: string) => (t.includes("{files}") ? t.replaceAll("{files}", fileList) : `${t} ${fileList}`);
  if (pattern === undefined) return withFiles(template);
  const filtered = config.commands.testFiltered;
  if (filtered) return withFiles(filtered).replaceAll("{pattern}", quoteArg(pattern));
  return `${withFiles(template)} -t ${quoteArg(pattern)}`;
}

/** True when aw agents must run tests through `aw test` (the default). */
export function directTestCommandsBlocked(config: Config): boolean {
  return config.guards.directTestCommands === DirectTestCommands.enum.block;
}

/**
 * Beginnings of commands that start a test runner: the defaults (`npm test`, `npx vitest`, …)
 * plus this repository's own test commands (`commands.test*`, `commands.e2e`) up to their first placeholder.
 */
export function testCommandPrefixes(config: Config): string[] {
  const configured = Object.entries(config.commands)
    .filter(([key]) => /^test/i.test(key) || key === "e2e")
    .map(([, command]) => command.split("{")[0]!.trim());
  return [...new Set([...config.guards.testCommandPrefixes, ...configured])].filter(Boolean);
}
