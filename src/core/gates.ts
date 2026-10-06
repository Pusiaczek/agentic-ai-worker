/** Gates: repository commands (lint, tests, …) the CLI runs itself at submit time, so results don't depend on an agent's word. */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { type Gate, GateExpectation } from "../schema/config";
import type { GateResult } from "../schema/state";
import { nowIso, tail, writeFileAtomic } from "../util/fsx";
import { type Ctx, rel } from "./project";
import { type TaskRef, taskPaths } from "./store";

/** Quote a file path for the shell only when needed. */
export const quoteFile = (f: string) => (/[\s"'&|<>^]/.test(f) ? `"${f.replace(/"/g, '\\"')}"` : f);

/** Always-quoted shell argument (test name patterns). */
export const quoteArg = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

export interface ExecResult {
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
  /** Project-relative path of the full log. */
  logFile: string;
}

/** Run a repository command through the shell, keep the full output in a log file. */
export function execLogged(ctx: Ctx, command: string, logFileAbs: string): ExecResult {
  const started = Date.now();
  const res = spawnSync(command, {
    cwd: ctx.root,
    shell: true,
    encoding: "utf8",
    timeout: ctx.config.limits.gateTimeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const durationMs = Date.now() - started;
  const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || res.signal === "SIGTERM";
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? `\n[aw] ${res.error.message}` : ""}`;
  writeFileAtomic(logFileAbs, `$ ${command}\n\n${output}\n[exit ${res.status ?? "none"}${timedOut ? ", timed out" : ""}]\n`);
  return { exitCode: res.status, durationMs, output, timedOut, logFile: rel(ctx, logFileAbs) };
}

export function runGates(ctx: Ctx, ref: TaskRef, runId: string, gates: Gate[], files: string[]): GateResult[] {
  return gates.map((gate) => runGate(ctx, ref, runId, gate, files));
}

function runGate(ctx: Ctx, ref: TaskRef, runId: string, gate: Gate, files: string[]): GateResult {
  const at = nowIso();
  const base = { name: gate.run, expect: gate.expect, at };
  let command = ctx.config.commands[gate.run];
  if (!command) {
    return { ...base, command: "", exitCode: null, ok: true, skipped: true, reason: "command not configured", durationMs: 0, outputTail: "" };
  }
  if (command.includes("{files}")) {
    if (files.length === 0) {
      return { ...base, command, exitCode: null, ok: true, skipped: true, reason: "no files for {files}", durationMs: 0, outputTail: "" };
    }
    command = command.replaceAll("{files}", files.map(quoteFile).join(" "));
  }

  const res = execLogged(ctx, command, path.join(taskPaths(ref).logs, `${runId}-${gate.run}.log`));
  const ok = gate.expect === GateExpectation.enum.pass ? res.exitCode === 0 : res.exitCode !== null && res.exitCode !== 0 && !res.timedOut;
  return {
    ...base,
    command,
    exitCode: res.exitCode,
    ok,
    skipped: false,
    ...(res.timedOut ? { reason: `timed out after ${ctx.config.limits.gateTimeoutSec}s` } : {}),
    durationMs: res.durationMs,
    outputTail: tail(res.output, 3000),
    logFile: res.logFile,
  };
}

export function describeGate(g: GateResult): string {
  if (g.skipped) return `${g.name}: skipped (${g.reason})`;
  const verdict = g.ok ? "ok" : "MISMATCH";
  return `${g.name}: ${verdict} — expected ${g.expect}, exit ${g.exitCode ?? "none"}${g.reason ? ` (${g.reason})` : ""} [${g.logFile}]`;
}
