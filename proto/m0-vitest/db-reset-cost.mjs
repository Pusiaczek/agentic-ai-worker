#!/usr/bin/env node
// M0 side measurement: what a test pays for a clean database in a PGlite project such as test-aw.
// Compares the project's approach (a new PGlite from a migrated copy for every test) with reusing one
// instance and emptying its tables with a single TRUNCATE, the reset the aw lanes plan for Postgres.
//
// Usage: node proto/m0-vitest/db-reset-cost.mjs <projectRoot> [--migrations drizzle] [--copies 20] [--truncates 200]
//
// Read-only for the project: migrations are applied to in-memory databases only.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    migrations: { type: "string", default: "drizzle" },
    copies: { type: "string", default: "20" },
    truncates: { type: "string", default: "200" },
  },
});

const projectRoot = resolve(positionals[0] ?? ".");
const projectRequire = createRequire(join(projectRoot, "package.json"));
const { PGlite } = await import(pathToFileURL(projectRequire.resolve("@electric-sql/pglite")).href);
// package.json is not in PGlite's "exports", so it is read by path.
const pgliteVersion = JSON.parse(readFileSync(join(projectRoot, "node_modules/@electric-sql/pglite/package.json"), "utf8")).version;

const templateStarted = performance.now();
const template = await buildTemplate();
const templateMs = performance.now() - templateStarted;

const copyDurations = await measureRepeatedly(Number(options.copies), async () => {
  const client = new PGlite({ loadDataDir: template.dataDir });
  await client.query("select 1");
  await client.close();
});

const reusedClient = new PGlite({ loadDataDir: template.dataDir });
const truncateAll = `TRUNCATE ${template.tables.map(quoteIdentifier).join(", ")} RESTART IDENTITY`;
const truncateDurations = await measureRepeatedly(Number(options.truncates), async () => {
  await reusedClient.exec(truncateAll);
});
await reusedClient.close();

const copy = describeDurations(copyDurations);
const truncate = describeDurations(truncateDurations);
console.log(
  [
    `PGlite ${pgliteVersion} · ${projectRoot} · tables: ${template.tables.join(", ")}`,
    `template (new PGlite + migrations + dump), once per test file: ${template.migrationFiles} migration file(s), ${templateMs.toFixed(0)} ms`,
    formatDurations("new PGlite from copy", copy),
    formatDurations("TRUNCATE on reused", truncate),
    `ratio of medians: ${(copy.median / truncate.median).toFixed(0)}x`,
  ].join("\n"),
);

/** What the project's helper builds once per test file: a migrated database dumped to a data dir. */
async function buildTemplate() {
  const migrationsDir = join(projectRoot, options.migrations);
  // Drizzle names migrations 0000_…, 0001_…, so name order is apply order; `--> statement-breakpoint` is a SQL comment.
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const client = new PGlite();
  for (const file of migrationFiles) await client.exec(readFileSync(join(migrationsDir, file), "utf8"));
  const tables = (await client.query("select tablename from pg_tables where schemaname = 'public' order by tablename")).rows.map(
    (row) => row.tablename,
  );
  const dataDir = await client.dumpDataDir("none");
  await client.close();
  return { dataDir, tables, migrationFiles: migrationFiles.length };
}

async function measureRepeatedly(count, action) {
  const durations = [];
  for (let attempt = 0; attempt < count; attempt++) {
    const started = performance.now();
    await action();
    durations.push(performance.now() - started);
  }
  return durations;
}

function describeDurations(durations) {
  const sorted = [...durations].sort((first, second) => first - second);
  const atFraction = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: sorted.length, min: sorted[0], median: atFraction(0.5), p90: atFraction(0.9), max: sorted.at(-1) };
}

function formatDurations(label, { count, min, median, p90, max }) {
  const rounded = (value) => (value < 10 ? value.toFixed(1) : value.toFixed(0));
  return `${label.padEnd(22)} ×${String(count).padEnd(4)} ms: min ${rounded(min)}, median ${rounded(median)}, p90 ${rounded(p90)}, max ${rounded(max)}`;
}

function quoteIdentifier(name) {
  return `"${name.replace(/"/g, '""')}"`;
}
