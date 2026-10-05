#!/usr/bin/env node
// M0 prototype of the aw test server — see docs/test-infra.md ("Etapy").
// Drives a project's own vitest through its Node API and compares it with a plain `npx vitest run`:
// K1 same results, K2 code changes are seen, K6 repo untouched, K8 timings; plus setup-file
// injection and the globalSetup lifetime.
//
// Usage: node proto/m0-vitest/m0.mjs <projectRoot> [--small <test file>]... [--filter <name pattern>] [--skip-plain]
//
// Each --small file runs SMALL_RUN_REPEATS times both ways; comparing files of different sizes shows
// whether the server's saving is a fixed cost per command.
//
// The only files it writes in the project are the __aw_probe__ files, removed in `finally`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PROBE_NAME = "__aw_probe__";
const PROBE_FRESHNESS_TEST = "sees the current value";
const PROBE_INJECTION_TEST = "runs after the aw setup file";
const LANE = "m0";
const MODULE_PHASES = ["environmentSetupDuration", "prepareDuration", "collectDuration", "setupDuration", "duration"];
const SMALL_RUN_REPEATS = 3;

const PROBE_TEST_SOURCE = `import { expect, test } from "vitest";
import { value } from "./${PROBE_NAME}.value";

test("${PROBE_FRESHNESS_TEST}", () => {
  expect(value).toBe(1);
});

test("${PROBE_INJECTION_TEST}", () => {
  expect(Reflect.get(globalThis, "__AW_INJECTED__")).toBe("${LANE}");
});
`;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    small: { type: "string", multiple: true, default: ["test/routes/health.test.ts"] },
    filter: { type: "string", default: "PATCH" },
    "skip-plain": { type: "boolean", default: false },
  },
});

const projectRoot = slash(resolve(positionals[0] ?? "."));
const workDir = slash(mkdtempSync(join(tmpdir(), "aw-m0-")));
const NPX_VITEST = ["npx", "vitest"];
const NODE_VITEST = ["node", `${projectRoot}/node_modules/vitest/vitest.mjs`];

process.chdir(projectRoot);
// The variables `aw test` and the gates already add, plus the lane read by the injected setup file.
Object.assign(process.env, { CI: "1", NO_COLOR: "1", AW_LANE: LANE });

async function main() {
  removeProbeLeftovers();
  const statusBefore = gitStatus();
  const report = { projectRoot, workDir, node: process.version };

  if (!options["skip-plain"]) {
    report.plain = {
      full: runPlain("plain full", NPX_VITEST, []),
      filter: runPlain(`plain -t ${options.filter}`, NPX_VITEST, ["-t", options.filter]),
      small: options.small.map((file) => ({
        file,
        npx: timesOf(SMALL_RUN_REPEATS, (attempt) => runPlain(`plain ${file} (npx) #${attempt}`, NPX_VITEST, [file])),
        node: runPlain(`plain ${file} (node)`, NODE_VITEST, [file]),
      })),
    };
  }

  const server = await WarmVitest.start();
  report.vitest = server.describe();
  let probe = null;
  try {
    report.server = { startup: server.startup, full: [], filter: [], small: [] };
    for (const attempt of [1, 2]) report.server.full.push(await server.run(`server full #${attempt}`));
    for (const attempt of [1, 2]) {
      report.server.filter.push(await server.run(`server -t ${options.filter} #${attempt}`, { namePattern: options.filter }));
    }
    for (const file of options.small) {
      const runs = [];
      for (let attempt = 1; attempt <= SMALL_RUN_REPEATS; attempt++) {
        runs.push(await server.run(`server ${file} #${attempt}`, { files: [file] }));
      }
      report.server.small.push({ file, runs });
    }
    probe = await server.placeProbe();
    report.probe = await runProbe(server, probe);
  } finally {
    if (probe) removeFiles([probe.testFile, probe.valueFile]);
    await server.close();
  }

  report.globalSetupEvents = readLines(server.globalSetupLog);
  report.repoUntouched = gitStatus() === statusBefore;
  report.checks = evaluateChecks(report);
  writeFileSync(`${workDir}/m0-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  const allPassed = Object.values(report.checks).every((check) => check.ok);
  process.exit(allPassed ? 0 : 1);
}

/** One vitest instance kept alive between runs — the core of the future test server. */
class WarmVitest {
  static async start() {
    const projectRequire = createRequire(`${projectRoot}/package.json`);
    const vitestNodeFile = projectRequire.resolve("vitest/node");
    const vitestVersion = JSON.parse(readFileSync(join(dirname(dirname(vitestNodeFile)), "package.json"), "utf8")).version;
    const vitestNode = await import(pathToFileURL(vitestNodeFile).href);
    const injected = writeInjectedFiles();
    const output = [];
    const outputSink = new Writable({
      write(chunk, _encoding, done) {
        output.push(String(chunk));
        done();
      },
    });

    const startup = {};
    let phaseStarted = performance.now();
    // Options passed through the API replace the project's arrays, so read the project's files first.
    const projectConfig = (await vitestNode.resolveConfig({ root: projectRoot, watch: false })).test;
    startup.resolveConfigMs = performance.now() - phaseStarted;

    phaseStarted = performance.now();
    const vitest = await vitestNode.createVitest(
      "test",
      {
        root: projectRoot,
        watch: false,
        reporters: [{}], // silent: results come from the API
        setupFiles: [injected.setupFile, ...projectConfig.setupFiles],
        globalSetup: [injected.globalSetupFile, ...projectConfig.globalSetup],
      },
      {},
      { stdout: outputSink, stderr: outputSink },
    );
    startup.createVitestMs = performance.now() - phaseStarted;

    phaseStarted = performance.now();
    await vitest.standalone();
    startup.standaloneMs = performance.now() - phaseStarted;

    if (vitest.projects.length !== 1) throw new Error(`M0 handles one vitest project, found ${vitest.projects.length}`);
    return new WarmVitest({ vitest, vitestVersion, projectConfig, startup, injected, output });
  }

  constructor({ vitest, vitestVersion, projectConfig, startup, injected, output }) {
    this.vitest = vitest;
    this.project = vitest.projects[0];
    this.vitestVersion = vitestVersion;
    this.projectConfig = projectConfig;
    this.startup = startup;
    this.globalSetupLog = injected.globalSetupLog;
    this.output = output;
  }

  describe() {
    const config = this.project.config;
    return {
      version: this.vitestVersion,
      pool: config.pool,
      maxWorkers: this.vitest.config.maxWorkers ?? `${availableParallelism() - 1} (default: cpus - 1)`,
      isolate: config.isolate,
      projectSetupFiles: this.projectConfig.setupFiles,
      projectGlobalSetup: this.projectConfig.globalSetup,
      setupFiles: config.setupFiles,
      globalSetup: config.globalSetup,
    };
  }

  /** Runs the given files (all test files when omitted), optionally filtered by test name like `-t`. */
  async run(label, { files, namePattern } = {}) {
    const specifications = await this.specificationsFor(files, namePattern);
    const started = performance.now();
    const result = await this.vitest.runTestSpecifications(specifications, files === undefined);
    const wallMs = performance.now() - started;
    const testModules = modulesOfThisRun(result, specifications);
    return {
      label,
      wallMs,
      rssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
      summary: summarizeServerResult(testModules, result.unhandledErrors),
      phases: sumModulePhases(testModules),
    };
  }

  async specificationsFor(files, namePattern) {
    const specificationOptions = namePattern ? { testNamePattern: new RegExp(namePattern) } : undefined;
    if (files) {
      return files.map((file) => this.project.createSpecification(slash(resolve(projectRoot, file)), specificationOptions));
    }
    const allFiles = await this.vitest.globTestSpecifications();
    return allFiles.map((specification) => this.project.createSpecification(specification.moduleId, specificationOptions));
  }

  /** Where the probe goes: next to an existing test file, with the shortest suffix the include globs accept. */
  async placeProbe() {
    const acceptsAsTest = (file) => this.project.matchesTestGlob(file, () => "");
    const testFiles = (await this.vitest.globTestSpecifications()).map((specification) => specification.moduleId).sort();
    for (const testFile of testFiles) {
      const nameParts = basename(testFile).split(".");
      const extension = `.${nameParts[nameParts.length - 1]}`;
      const valueFile = slash(join(dirname(testFile), `${PROBE_NAME}.value${extension}`));
      for (let suffixStart = nameParts.length - 1; suffixStart >= 1; suffixStart--) {
        const testSuffix = `.${nameParts.slice(suffixStart).join(".")}`;
        const probeTestFile = slash(join(dirname(testFile), `${PROBE_NAME}${testSuffix}`));
        if (acceptsAsTest(probeTestFile) && !acceptsAsTest(valueFile)) return { testFile: probeTestFile, valueFile };
      }
    }
    return null;
  }

  async probeRun(probe, label) {
    const started = performance.now();
    const specifications = [this.project.createSpecification(probe.testFile)];
    const result = await this.vitest.runTestSpecifications(specifications);
    const wallMs = performance.now() - started;
    const states = new Map();
    const errors = [];
    for (const testModule of modulesOfThisRun(result, specifications)) {
      errors.push(...testModule.errors().map((error) => error.message));
      for (const testCase of testModule.children.allTests()) states.set(testCase.name, testCase.result().state);
    }
    return {
      label,
      wallMs,
      freshness: states.get(PROBE_FRESHNESS_TEST) ?? "missing",
      injection: states.get(PROBE_INJECTION_TEST) ?? "missing",
      errors,
    };
  }

  /** What vitest's own watcher does on a change, minus the automatic rerun. */
  invalidate(files) {
    for (const file of files) {
      const moduleId = slash(resolve(projectRoot, file));
      this.vitest.invalidateFile(moduleId);
      this.vitest.watcher.invalidates.add(moduleId);
    }
  }

  async close() {
    await this.vitest.close();
    if (this.output.length > 0) writeFileSync(`${workDir}/vitest-output.log`, this.output.join(""));
  }
}

/**
 * K2: the probe test expects value 1, so changing the module to 2 must make it fail and changing it back
 * must make it pass. The step without invalidation shows what a server relying on nothing would report.
 */
async function runProbe(server, probe) {
  if (!probe) return { error: `no test directory accepts ${PROBE_NAME} files` };
  writeFileSync(probe.valueFile, valueModule(1));
  writeFileSync(probe.testFile, PROBE_TEST_SOURCE);
  const baseline = scanRelevantFiles();
  const steps = [await server.probeRun(probe, "value 1")];

  writeFileSync(probe.valueFile, valueModule(2));
  steps.push(await server.probeRun(probe, "value 2, not invalidated"));

  const scanStarted = performance.now();
  const afterChange = scanRelevantFiles();
  const scanMs = performance.now() - scanStarted;
  const changed = changedFiles(baseline, afterChange);
  server.invalidate(changed);
  steps.push(await server.probeRun(probe, "value 2, invalidated"));

  writeFileSync(probe.valueFile, valueModule(1));
  const changedBack = changedFiles(afterChange, scanRelevantFiles());
  server.invalidate(changedBack);
  steps.push(await server.probeRun(probe, "value 1, invalidated"));

  return {
    files: { test: probe.testFile, value: probe.valueFile },
    steps,
    changed,
    changedBack,
    scan: { files: afterChange.size, ms: scanMs },
  };
}

function valueModule(value) {
  return `export const value = ${value};\n`;
}

/** Modification time and size of every tracked or new non-ignored file, keyed by repo-relative path. */
function scanRelevantFiles() {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).stdout;
  const signatures = new Map();
  for (const file of listed.split("\0")) {
    if (!file || file.startsWith(".tasks/")) continue;
    try {
      const stats = statSync(`${projectRoot}/${file}`);
      signatures.set(file, `${stats.mtimeMs}:${stats.size}`);
    } catch {
      // deleted between listing and stat: it counts as removed
    }
  }
  return signatures;
}

function changedFiles(before, after) {
  const changed = [];
  for (const [file, signature] of after) if (before.get(file) !== signature) changed.push(file);
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return changed;
}

function writeInjectedFiles() {
  const setupFile = `${workDir}/aw-setup.mjs`;
  writeFileSync(setupFile, `globalThis.__AW_INJECTED__ = process.env.AW_LANE ?? "missing";\n`);
  const globalSetupLog = `${workDir}/global-setup.log`;
  const globalSetupFile = `${workDir}/aw-global-setup.mjs`;
  writeFileSync(
    globalSetupFile,
    [
      'import { appendFileSync } from "node:fs";',
      `const log = ${JSON.stringify(globalSetupLog)};`,
      "export default function setup() {",
      '  appendFileSync(log, "setup\\n");',
      '  return () => appendFileSync(log, "teardown\\n");',
      "}",
      "",
    ].join("\n"),
  );
  return { setupFile, globalSetupFile, globalSetupLog };
}

/** A new vitest process per call, the way `aw test` runs tests today. Results come from the JSON reporter. */
function runPlain(label, launcher, args) {
  const outputFile = `${workDir}/${label.replace(/\W+/g, "-")}.json`;
  const command = [...launcher, "run", ...args, "--reporter=json", `--outputFile=${outputFile}`].map(quoteArg).join(" ");
  const started = performance.now();
  const child = spawnSync(command, { cwd: projectRoot, shell: true, encoding: "utf8", maxBuffer: 256 * 2 ** 20 });
  const wallMs = performance.now() - started;
  if (!existsSync(outputFile)) {
    return { label, command, wallMs, exitCode: child.status, error: tail(child.stderr || child.stdout) };
  }
  const summary = summarizeJsonReport(JSON.parse(readFileSync(outputFile, "utf8")));
  return { label, command, wallMs, exitCode: child.status, summary };
}

function summarizeJsonReport(report) {
  const tests = report.testResults.flatMap((fileResult) =>
    fileResult.assertionResults.map((assertion) => ({
      file: slash(relative(projectRoot, fileResult.name)),
      name: normalizeTestName(assertion.fullName),
      state: normalizeState(assertion.status),
      durationMs: assertion.duration ?? 0,
    })),
  );
  const fileErrors = report.testResults.filter(
    (fileResult) => fileResult.status === "failed" && fileResult.assertionResults.length === 0,
  ).length;
  return summarizeTests(tests, fileErrors);
}

/** `runTestSpecifications` returns every module vitest knows, earlier runs included; keep the ones this run asked for. */
function modulesOfThisRun(result, specifications) {
  const requested = new Set(specifications.map((specification) => specification.moduleId));
  return result.testModules.filter((testModule) => requested.has(testModule.moduleId));
}

function summarizeServerResult(testModules, unhandledErrors) {
  const tests = [];
  let fileErrors = 0;
  for (const testModule of testModules) {
    if (testModule.errors().length > 0) fileErrors++;
    for (const testCase of testModule.children.allTests()) {
      tests.push({
        file: slash(relative(projectRoot, testModule.moduleId)),
        name: normalizeTestName(testCase.fullName),
        state: normalizeState(testCase.result().state),
        durationMs: testCase.diagnostic()?.duration ?? 0,
      });
    }
  }
  return { ...summarizeTests(tests, fileErrors), unhandledErrors: unhandledErrors.length };
}

function summarizeTests(tests, fileErrors) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const test of tests) counts[test.state]++;
  const failedTests = tests
    .filter((test) => test.state === "failed")
    .map((test) => `${test.file} › ${test.name}`)
    .sort();
  const executed = tests.filter((test) => test.state !== "skipped").map((test) => test.durationMs);
  return { ...counts, fileErrors, failedTests, durations: describeDurations(executed) };
}

/** Collapses runner-specific states (pending, todo, disabled…) into passed / failed / skipped. */
function normalizeState(state) {
  if (state === "passed" || state === "failed") return state;
  return "skipped";
}

/** The JSON reporter and the Node API join suite and test names differently. */
function normalizeTestName(fullName) {
  return fullName.split(" > ").join(" ");
}

function describeDurations(durations) {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((first, second) => first - second);
  const atFraction = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  const sum = sorted.reduce((total, duration) => total + duration, 0);
  return { count: sorted.length, min: sorted[0], median: atFraction(0.5), p90: atFraction(0.9), max: sorted.at(-1), sum };
}

function sumModulePhases(testModules) {
  const totals = Object.fromEntries(MODULE_PHASES.map((phase) => [phase, 0]));
  for (const testModule of testModules) {
    const diagnostic = testModule.diagnostic();
    for (const phase of MODULE_PHASES) totals[phase] += diagnostic[phase] ?? 0;
  }
  return totals;
}

function sameResults(plainRun, serverRun) {
  if (!plainRun?.summary || !serverRun?.summary) return false;
  const countsEqual = ["passed", "failed", "skipped", "fileErrors"].every(
    (key) => plainRun.summary[key] === serverRun.summary[key],
  );
  return countsEqual && JSON.stringify(plainRun.summary.failedTests) === JSON.stringify(serverRun.summary.failedTests);
}

function evaluateChecks(report) {
  const checks = {};
  if (report.plain) {
    const comparisons = [
      ["full", report.plain.full, report.server.full[1]],
      ["filter", report.plain.filter, report.server.filter[0]],
      ...report.plain.small.map((target, index) => [target.file, target.npx[0], report.server.small[index].runs[0]]),
    ];
    const differing = comparisons.filter(([, plainRun, serverRun]) => !sameResults(plainRun, serverRun));
    const names = (entries) => entries.map(([name]) => name).join(", ");
    checks.K1 = {
      ok: differing.length === 0,
      detail: differing.length === 0 ? `equal: ${names(comparisons)}` : `differ: ${names(differing)}`,
    };
  }
  const steps = report.probe.steps ?? [];
  const freshnessAt = (index) => steps[index]?.freshness;
  checks.K2 = {
    ok: freshnessAt(0) === "passed" && freshnessAt(2) === "failed" && freshnessAt(3) === "passed",
    detail: report.probe.error ?? steps.map((step) => `${step.label}: ${step.freshness}`).join("; "),
  };
  checks.K6 = { ok: report.repoUntouched, detail: report.repoUntouched ? "git status identical" : "git status changed" };
  checks.injection = {
    ok: steps.length > 0 && steps.every((step) => step.injection === "passed"),
    detail: `setupFiles = ${report.vitest.setupFiles.map(shortPath).join(", ")}`,
  };
  const smallRunCount = report.server.small.reduce((total, target) => total + target.runs.length, 0);
  const serverRunCount = report.server.full.length + report.server.filter.length + smallRunCount + steps.length;
  checks.globalSetup = {
    ok: report.globalSetupEvents.join(",") === "setup,teardown",
    detail: `events over ${serverRunCount} runs: ${report.globalSetupEvents.join(", ") || "none"}`,
  };
  return checks;
}

function printReport(report) {
  const { vitest, server } = report;
  const lines = [
    `M0 · vitest ${vitest.version} · ${report.projectRoot} · node ${report.node}`,
    `pool ${vitest.pool}, maxWorkers ${vitest.maxWorkers}, isolate ${vitest.isolate}`,
  ];
  if (report.plain) {
    lines.push("", "Plain runs (a new process each):");
    for (const run of [report.plain.full, report.plain.filter]) lines.push(formatRun(run));
  }
  const { startup } = server;
  lines.push(
    "",
    `Server (one warm instance), startup: resolveConfig ${seconds(startup.resolveConfigMs)}, createVitest ${seconds(startup.createVitestMs)}, standalone ${seconds(startup.standaloneMs)}`,
  );
  for (const run of [...server.full, ...server.filter]) lines.push(formatRun(run));

  lines.push("", `Per command, median of ${SMALL_RUN_REPEATS} runs (plain: a new process per command):`);
  for (const [index, target] of server.small.entries()) lines.push(formatPerCommand(target, report.plain?.small[index]));

  if (report.probe.steps) {
    const { scan } = report.probe;
    lines.push("", `Probe ${shortPath(report.probe.files.test)} · change scan: ${scan.files} files in ${scan.ms.toFixed(0)} ms, found ${report.probe.changed.join(", ")}`);
    for (const step of report.probe.steps) {
      const errors = step.errors.length > 0 ? `, errors: ${step.errors.join(" | ")}` : "";
      lines.push(`  ${step.label.padEnd(26)} ${seconds(step.wallMs).padStart(7)}  freshness test ${step.freshness}, injection test ${step.injection}${errors}`);
    }
  }

  lines.push("", "Per-test duration in ms (includes beforeEach/afterEach):");
  if (report.plain?.full.summary) lines.push(formatDurations("plain full", report.plain.full.summary.durations));
  lines.push(formatDurations("server full #2", server.full[1].summary.durations));
  const phases = server.full[1].phases;
  lines.push(
    `Module phases, server full #2 (summed over files): environment ${seconds(phases.environmentSetupDuration)}, prepare ${seconds(phases.prepareDuration)}, collect ${seconds(phases.collectDuration)}, setup ${seconds(phases.setupDuration)}, tests ${seconds(phases.duration)}`,
  );

  lines.push("", "Checks:");
  for (const [name, check] of Object.entries(report.checks)) lines.push(`  ${check.ok ? "✓" : "✗"} ${name}: ${check.detail}`);
  lines.push("", `Full report: ${report.workDir}/m0-report.json`);
  console.log(lines.join("\n"));
}

function formatRun(run) {
  const label = run.label.padEnd(26);
  const wall = seconds(run.wallMs).padStart(7);
  if (!run.summary) return `  ${label} ${wall}  no results (exit ${run.exitCode}): ${run.error}`;
  const { passed, failed, skipped, fileErrors } = run.summary;
  const memory = run.rssMb === undefined ? "" : `, server rss ${run.rssMb} MB`;
  return `  ${label} ${wall}  passed ${passed}, failed ${failed}, skipped ${skipped}, file errors ${fileErrors}${memory}`;
}

/** One --small file: plain `npx` and `node` launches next to the server, and what the server saves. */
function formatPerCommand(serverTarget, plainTarget) {
  const executed = serverTarget.runs[0].summary;
  const serverMs = medianOf(serverTarget.runs.map((run) => run.wallMs));
  const cells = [`${serverTarget.file.padEnd(38)} ${String(executed.passed + executed.failed).padStart(3)} tests`];
  if (plainTarget) {
    const npxMs = medianOf(plainTarget.npx.map((run) => run.wallMs));
    cells.push(`npx ${preciseSeconds(npxMs)}`, `node ${preciseSeconds(plainTarget.node.wallMs)}`);
    cells.push(`server ${preciseSeconds(serverMs)}`, `saved vs npx ${preciseSeconds(npxMs - serverMs)}`);
  } else {
    cells.push(`server ${preciseSeconds(serverMs)}`);
  }
  return `  ${cells.join(" · ")}`;
}

function formatDurations(label, durations) {
  if (!durations) return `  ${label}: no executed tests`;
  const { count, min, median, p90, max, sum } = durations;
  const rounded = (value) => value.toFixed(0);
  return `  ${label.padEnd(16)} ${count} tests: min ${rounded(min)}, median ${rounded(median)}, p90 ${rounded(p90)}, max ${rounded(max)}, sum ${seconds(sum)}`;
}

/** Deletes __aw_probe__ files a crashed run left behind (untracked files with the probe name). */
function removeProbeLeftovers() {
  const untracked = spawnSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).stdout;
  const leftovers = untracked.split("\0").filter((file) => basename(file).startsWith(PROBE_NAME));
  removeFiles(leftovers.map((file) => `${projectRoot}/${file}`));
}

function removeFiles(files) {
  for (const file of files) rmSync(file, { force: true });
}

/**
 * The project's git status with every untracked file listed on its own line, so a leftover probe file
 * shows up even inside an untracked directory (e.g. a fixture that lives in another repo).
 */
function gitStatus() {
  return spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "."], {
    cwd: projectRoot,
    encoding: "utf8",
  }).stdout;
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function shortPath(file) {
  return slash(file).startsWith(projectRoot) ? slash(relative(projectRoot, file)) : slash(file);
}

function tail(text, lineCount = 8) {
  return (text ?? "").trim().split("\n").slice(-lineCount).join("\n");
}

function quoteArg(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

function preciseSeconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

function medianOf(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Calls `action(attempt)` for attempts 1…count and collects the results. */
function timesOf(count, action) {
  return Array.from({ length: count }, (_, index) => action(index + 1));
}

/** Forward slashes, as vitest module ids use them on Windows too. */
function slash(path) {
  return path.replace(/\\/g, "/");
}

// Last, after every declaration: classes are not hoisted, so calling main() earlier hits WarmVitest uninitialized.
await main();
