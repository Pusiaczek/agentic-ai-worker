#!/usr/bin/env node
// M0 side measurement: the same test suite on every test database variant, for a project whose
// vitest config picks the test database from the vitest mode (fixtures/test-aw: pglite,
// pglite-truncate, postgres, postgres-truncate). Answers "does a separate Postgres help?" apart
// from "does TRUNCATE instead of a new database help?".
//
// Usage: node proto/m0-vitest/db-matrix.mjs <projectRoot> [--repeat 3] [--mode <vitest mode>]...
//          [--server <label>=<postgres url>]... [--file <test file>]...
//
// Postgres modes (names starting with "postgres") run once per --server; without --server they use
// TEST_DATABASE_URL from the environment or the project's .env.test. Attempts are interleaved (every
// variant once, then again), so a machine that gets busier or quieter affects all variants alike.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repeat: { type: "string", default: "3" },
    mode: { type: "string", multiple: true, default: ["pglite", "pglite-truncate", "postgres", "postgres-truncate"] },
    server: { type: "string", multiple: true, default: [] },
    file: { type: "string", multiple: true, default: [] },
  },
});

const projectRoot = resolve(positionals[0] ?? ".");
const workDir = mkdtempSync(join(tmpdir(), "aw-db-matrix-"));
const vitestBin = join(projectRoot, "node_modules/vitest/vitest.mjs");
const repeatCount = Number(options.repeat);

const variants = buildVariants();
for (let attempt = 1; attempt <= repeatCount; attempt++) {
  for (const variant of variants) variant.runs.push(runSuite(variant, attempt));
}

writeFileSync(join(workDir, "db-matrix.json"), `${JSON.stringify({ projectRoot, files: options.file, variants }, null, 2)}\n`);
printReport(variants);

/** Every --mode; a postgres mode once per --server, with that server's URL. */
function buildVariants() {
  const servers = options.server.map(parseServer);
  return options.mode.flatMap((mode) => {
    if (!isPostgresMode(mode) || servers.length === 0) return [{ name: mode, mode, env: {}, runs: [] }];
    return servers.map((server) => ({
      name: `${mode} @ ${server.label}`,
      mode,
      env: { TEST_DATABASE_URL: server.url },
      runs: [],
    }));
  });
}

function isPostgresMode(mode) {
  return mode.startsWith("postgres");
}

function parseServer(value) {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error(`--server expects <label>=<postgres url>, got "${value}"`);
  return { label: value.slice(0, separator), url: value.slice(separator + 1) };
}

/** One `vitest run --mode <mode>` in a new process; results from the JSON reporter. */
function runSuite(variant, attempt) {
  const outputFile = join(workDir, `${variant.name.replace(/\W+/g, "-")}-${attempt}.json`);
  const started = performance.now();
  const child = spawnSync(
    process.execPath,
    [vitestBin, "run", ...options.file, "--mode", variant.mode, "--reporter=json", `--outputFile=${outputFile}`],
    {
      cwd: projectRoot,
      env: { ...process.env, CI: "1", NO_COLOR: "1", ...variant.env },
      encoding: "utf8",
      maxBuffer: 256 * 2 ** 20,
    },
  );
  const wallMs = performance.now() - started;
  const error = () => ({ wallMs, error: firstErrorLine(`${child.stdout}\n${child.stderr}`) });
  if (!existsSync(outputFile)) return error();
  const report = JSON.parse(readFileSync(outputFile, "utf8"));
  if (failedBeforeAnyFile(report)) return error();
  return { wallMs, ...summarize(report) };
}

/** Vitest still writes an (empty) JSON report when e.g. globalSetup throws; that is no result. */
function failedBeforeAnyFile(report) {
  return !report.success && report.testResults.length === 0;
}

function summarize(report) {
  const tests = report.testResults.flatMap((fileResult) => fileResult.assertionResults);
  const executed = tests
    .filter((test) => test.status === "passed" || test.status === "failed")
    .map((test) => test.duration ?? 0)
    .sort((first, second) => first - second);
  return {
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests + report.numTodoTests,
    fileErrors: report.testResults.filter((fileResult) => fileResult.status === "failed" && fileResult.assertionResults.length === 0).length,
    testMedianMs: executed[Math.floor(executed.length / 2)] ?? 0,
    testP90Ms: executed[Math.floor(executed.length * 0.9)] ?? 0,
  };
}

function printReport(variants) {
  const lines = [
    `DB matrix · ${projectRoot}${options.file.length > 0 ? ` · ${options.file.join(", ")}` : " · full suite"} · median of ${repeatCount} runs`,
    `  ${"variant".padEnd(30)} ${"wall".padStart(8)} ${"test median".padStart(12)} ${"test p90".padStart(9)}   results`,
  ];
  for (const { name, runs } of variants) {
    const label = `  ${name.padEnd(30)}`;
    const completed = runs.filter((run) => run.error === undefined);
    if (completed.length === 0) {
      lines.push(`${label} no results: ${runs[0].error}`);
      continue;
    }
    const wall = seconds(medianOf(completed.map((run) => run.wallMs))).padStart(8);
    const median = `${medianOf(completed.map((run) => run.testMedianMs)).toFixed(0)} ms`.padStart(12);
    const p90 = `${medianOf(completed.map((run) => run.testP90Ms)).toFixed(0)} ms`.padStart(9);
    lines.push(`${label} ${wall} ${median} ${p90}   ${describeResults(completed)}`);
  }
  lines.push("", sameResultsLine(variants), `Runs: ${workDir}`);
  console.log(lines.join("\n"));
}

function describeResults(runs) {
  const distinct = [...new Set(runs.map((run) => `passed ${run.passed}, failed ${run.failed}, skipped ${run.skipped}, file errors ${run.fileErrors}`))];
  return distinct.join(" | ");
}

/** Every variant must give the same counts: the database choice may change speed, never results. */
function sameResultsLine(variants) {
  const counts = variants.flatMap(({ runs }) =>
    runs.filter((run) => run.error === undefined).map((run) => `${run.passed}/${run.failed}/${run.skipped}/${run.fileErrors}`),
  );
  if (counts.length === 0) return "✗ no variant produced results";
  const identical = new Set(counts).size === 1;
  return identical ? `✓ same results in every run (${counts[0]} passed/failed/skipped/file errors)` : `✗ results differ between runs: ${[...new Set(counts)].join(", ")}`;
}

/** The thrown error's message line (e.g. "Error: connect ECONNREFUSED …"), else the last output line. */
function firstErrorLine(output) {
  const lines = output.split("\n");
  const thrown = lines.find((line) => /^\s*\w*Error:/.test(line));
  return (thrown ?? lines.filter((line) => line.trim()).at(-1) ?? "no output").trim().slice(0, 200);
}

function medianOf(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}
