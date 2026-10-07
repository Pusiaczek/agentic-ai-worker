/**
 * `aw test [<file>...] [-t "<name>"]` — run this task's tests (or the given files), narrowly, with a
 * compact result. Agents use it instead of the test runner; the full suite runs once as a gate at submit.
 * Every call made during an agent run is recorded on that run (count, duration), so time spent on tests shows up in reports.
 */
import * as path from "node:path";
import { execLogged } from "../core/gates";
import { activeRun } from "../core/machine";
import { loadCtx } from "../core/project";
import { findActiveTask, mutate, readState, taskPaths } from "../core/store";
import { buildTestCommand, taskTestFiles } from "../core/tests";
import type { Io } from "../io";
import { RunState, type TaskState } from "../schema/state";
import { parseArgs, str } from "../util/args";
import { AwError, EXIT } from "../util/errors";
import { ensureDir, nowIso, relativeToRoot } from "../util/fsx";

export const USAGE = 'aw test [<test file>...] [-t "<test name pattern>"]';
const TAIL_ON_PASS = 12;
const TAIL_ON_FAIL = 60;

export function testCommand(argv: string[], io: Io): number {
  const args = parseArgs(argv.map((a) => (a === "-t" ? "--name" : a)));
  const ctx = loadCtx(io.cwd);
  const pattern = str(args, "name");
  const ref = findActiveTask(ctx);
  const state: TaskState | null = ref ? readState(ref) : null;

  let files = args.positionals.map((f) => {
    const relPath = relativeToRoot(ctx.root, f, io.cwd);
    if (!relPath) throw new AwError(`${f} is outside the project.`, EXIT.USAGE);
    return relPath;
  });
  if (!files.length) {
    if (!state) throw new AwError("No active task, so there are no task test files.", EXIT.USAGE, `Pass files explicitly: ${USAGE}`);
    files = taskTestFiles(ctx, state);
    if (!files.length) throw new AwError("This task has no test files yet.", EXIT.USAGE, `Pass files explicitly: ${USAGE}`);
  }

  const command = buildTestCommand(ctx.config, files, pattern);
  const run = state ? activeRun(state) : undefined;
  const logsDir = ref ? taskPaths(ref).logs : path.join(ctx.tasksDir, "logs");
  ensureDir(logsDir);
  const res = execLogged(ctx, command, path.join(logsDir, `${run?.id ?? "task"}-test-${Date.now()}.log`));

  if (ref && run) {
    try {
      mutate(ref, (s) => {
        const r = s.runs.find((x) => x.id === run.id);
        if (r?.state !== RunState.enum.active) return;
        r.testRuns.push({
          at: nowIso(),
          durationMs: res.durationMs,
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          files: files.length,
          ...(pattern !== undefined ? { pattern } : {}),
          logFile: res.logFile,
        });
      });
    } catch {
      // Recording is bookkeeping; never hide the test result because of it.
    }
  }

  const passed = res.exitCode === 0 && !res.timedOut;
  const verdict = res.timedOut ? "TIMED OUT" : passed ? "passed" : `FAILED (exit ${res.exitCode ?? "none"})`;
  const seconds = (res.durationMs / 1000).toFixed(1);
  io.out(`aw test · ${files.length} file(s)${pattern !== undefined ? ` · filter "${pattern}"` : ""} · ${verdict} · ${seconds}s`);
  io.out(`$ ${command}`);
  const lines = res.output.trimEnd().split(/\r?\n/);
  const shown = lines.slice(-(passed ? TAIL_ON_PASS : TAIL_ON_FAIL));
  if (lines.length > shown.length) io.out(`… (${lines.length - shown.length} earlier lines in the log)`);
  io.out(shown.join("\n"));
  io.out(`Full log: ${res.logFile}`);
  return passed ? EXIT.OK : EXIT.ERROR;
}
