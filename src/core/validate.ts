/**
 * Checks on agent output that a schema can't express: references to acceptance criteria,
 * findings and notes, coverage, file existence, protected-file integrity.
 * Errors make the CLI refuse the submission; warnings are stored for the next reviewer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "../schema/config";
import { type CoderOutput, isBlocking, type RefineOutput, type ReviewerOutput, type TesterOutput } from "../schema/outputs";
import type { ReviewerRun, Run, TaskState } from "../schema/state";
import type { ReviewTarget } from "../schema/status";
import { fileSha256, relativeToRoot } from "../util/fsx";
import { globMatcher } from "../util/glob";
import { acIds, openBlockingFindings, protectedTests } from "./machine";
import type { Ctx } from "./project";

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

/** Rewrites paths to project-relative posix form; reports paths outside the project. */
export function normalizePath(ctx: Ctx, p: string, where: string, errors: string[]): string {
  const relPath = relativeToRoot(ctx.root, p);
  if (relPath === null) {
    errors.push(`${where}: ${p} is outside the project`);
    return p;
  }
  return relPath;
}

const exists = (ctx: Ctx, relPath: string) => fs.existsSync(path.join(ctx.root, relPath));

function checkAcRefs(s: TaskState, refs: { ac: string; where: string }[], errors: string[]): void {
  const known = new Set(acIds(s));
  for (const r of refs) if (!known.has(r.ac)) errors.push(`${r.where}: unknown acceptance criterion ${r.ac} (known: ${[...known].join(", ")})`);
}

function checkCoverage(s: TaskState, covered: Set<string>, untested: Set<string>, errors: string[]): void {
  for (const ac of acIds(s)) {
    if (!covered.has(ac) && !untested.has(ac)) {
      errors.push(`${ac} is neither covered by a test nor listed in untestedCriteria (with a reason)`);
    }
  }
}

function checkAddressed(
  s: TaskState,
  target: ReviewTarget,
  run: Run,
  out: Pick<CoderOutput, "addressedFindings" | "addressedNotes">,
  errors: string[],
): void {
  const open = openBlockingFindings(s, target);
  const openIds = new Set(open.map((f) => f.id));
  const given = new Set(out.addressedFindings.map((a) => a.findingId));
  for (const f of open) {
    if (!given.has(f.id)) errors.push(`addressedFindings: missing ${f.id} (${f.severity}) — every finding under "Must address" needs an entry`);
  }
  for (const id of given) {
    if (!openIds.has(id)) errors.push(`addressedFindings: ${id} is not an open blocking finding assigned to you`);
  }
  const assigned = new Set(run.consumedNotes);
  const notes = new Set(out.addressedNotes.map((n) => n.noteId));
  for (const id of assigned) if (!notes.has(id)) errors.push(`addressedNotes: missing ${id}`);
  for (const id of notes) if (!assigned.has(id)) errors.push(`addressedNotes: ${id} was not assigned to this run`);
}

export function checkTester(ctx: Ctx, s: TaskState, run: Run, out: TesterOutput): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isTestFile = globMatcher(ctx.config.tests.globs);

  out.tests.forEach((t, i) => (t.file = normalizePath(ctx, t.file, `tests[${i}].file`, errors)));
  out.supportFiles = out.supportFiles.map((f, i) => normalizePath(ctx, f, `supportFiles[${i}]`, errors));

  checkAcRefs(s, [
    ...out.tests.flatMap((t, i) => t.covers.map((ac) => ({ ac, where: `tests[${i}].covers` }))),
    ...out.untestedCriteria.map((u, i) => ({ ac: u.ac, where: `untestedCriteria[${i}]` })),
  ], errors);
  checkCoverage(
    s,
    new Set(out.tests.flatMap((t) => t.covers)),
    new Set(out.untestedCriteria.map((u) => u.ac)),
    errors,
  );

  for (const f of new Set([...out.tests.map((t) => t.file), ...out.supportFiles])) {
    if (!exists(ctx, f)) errors.push(`file not found: ${f}`);
    else if (!isTestFile(f)) errors.push(`${f} does not match tests.globs (${ctx.config.tests.globs.join(", ")}) — the tester may only create test files`);
  }
  const seen = new Set<string>();
  for (const t of out.tests) {
    const key = `${t.file}::${t.title}`;
    if (seen.has(key)) errors.push(`duplicate test: ${t.file} — ${t.title}`);
    seen.add(key);
  }
  if (!out.tests.some((t) => t.edgeCase)) warnings.push("tester marked no test as an edge case");

  checkAddressed(s, "tests", run, out, errors);
  return { errors, warnings };
}

export function checkReviewer(ctx: Ctx, s: TaskState, run: ReviewerRun, out: ReviewerOutput): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  out.findings.forEach((f, i) => {
    if (f.file) f.file = normalizePath(ctx, f.file, `findings[${i}].file`, errors);
    if (f.file && !exists(ctx, f.file)) warnings.push(`findings[${i}] refers to a file that does not exist: ${f.file}`);
  });

  const acs = acIds(s);
  const seen = new Set<string>();
  checkAcRefs(s, out.acCoverage.map((c, i) => ({ ac: c.ac, where: `acCoverage[${i}]` })), errors);
  for (const c of out.acCoverage) {
    if (seen.has(c.ac)) errors.push(`acCoverage: ${c.ac} listed twice`);
    seen.add(c.ac);
  }
  for (const ac of acs) if (!seen.has(ac)) errors.push(`acCoverage: missing ${ac} — assess every acceptance criterion`);

  const open = openBlockingFindings(s, run.target);
  const given = new Set(out.previousFindings.map((p) => p.id));
  for (const f of open) {
    if (!given.has(f.id)) errors.push(`previousFindings: missing ${f.id} — give a status for every open blocking finding from earlier rounds`);
  }
  for (const id of given) {
    if (!open.some((f) => f.id === id)) errors.push(`previousFindings: ${id} is not an open blocking finding`);
  }

  const newBlocking = out.findings.filter((f) => isBlocking(f.severity)).length;
  const notFixed = out.previousFindings.filter((p) => p.status === "not_fixed").length;
  if (out.verdict === "approve") {
    if (newBlocking) errors.push(`verdict "approve" with ${newBlocking} blocker/major finding(s) — request changes or lower their severity`);
    if (notFixed) errors.push(`verdict "approve" while ${notFixed} previous finding(s) are not_fixed`);
    const missing = out.acCoverage.filter((c) => c.verdict === "missing").map((c) => c.ac);
    if (missing.length) errors.push(`verdict "approve" but acCoverage marks ${missing.join(", ")} as missing`);
  } else if (!newBlocking && !notFixed) {
    errors.push(
      'verdict "changes_requested" needs at least one blocker/major finding (new or not_fixed); for non-blocking remarks use minor/nit findings or followUps and approve',
    );
  }
  return { errors, warnings };
}

export function checkCoder(ctx: Ctx, s: TaskState, run: Run, out: CoderOutput): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  out.filesChanged.forEach((f, i) => (f.path = normalizePath(ctx, f.path, `filesChanged[${i}].path`, errors)));
  out.testsAdded.forEach((t, i) => (t.file = normalizePath(ctx, t.file, `testsAdded[${i}].file`, errors)));
  out.docsUpdated.forEach((d, i) => (d.path = normalizePath(ctx, d.path, `docsUpdated[${i}].path`, errors)));

  checkAddressed(s, "code", run, out, errors);

  const testIds = new Set(protectedTests(s).map((t) => t.id));
  for (const d of out.testDisputes) {
    if (!testIds.has(d.testId)) errors.push(`testDisputes: ${d.testId} is not one of the protected tests`);
  }

  for (const p of s.protectedFiles) {
    if (fileSha256(path.join(ctx.root, p.path)) !== p.sha256) {
      errors.push(
        `protected test file was modified: ${p.path} — restore the original from ${p.snapshot}. If you believe the test is wrong, report it in testDisputes instead of changing it.`,
      );
    }
  }

  checkAcRefs(s, [
    ...out.testsAdded.flatMap((t, i) => t.covers.map((ac) => ({ ac, where: `testsAdded[${i}].covers` }))),
    ...out.untestedCriteria.map((u, i) => ({ ac: u.ac, where: `untestedCriteria[${i}]` })),
  ], errors);
  if (s.mode === "light") {
    checkCoverage(
      s,
      new Set(out.testsAdded.flatMap((t) => t.covers)),
      new Set(out.untestedCriteria.map((u) => u.ac)),
      errors,
    );
  }

  for (const f of out.filesChanged) {
    if (f.change !== "deleted" && !exists(ctx, f.path)) warnings.push(`filesChanged lists ${f.path} as ${f.change}, but it does not exist`);
  }
  for (const t of out.testsAdded) {
    if (!exists(ctx, t.file)) errors.push(`testsAdded: file not found: ${t.file}`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- product owner (refinement)

/** Every item must deliver something from the slice, or prepare a later item that does. */
function checkItemPurpose(out: RefineOutput, errors: string[]): void {
  const covered = new Set(out.coverage.flatMap((entry) => entry.items));
  const isNeededByLaterItem = (position: number) =>
    out.items.some((other, index) => index + 1 > position && other.dependsOn.includes(position));
  out.items.forEach((item, index) => {
    const position = index + 1;
    if (covered.has(position)) return;
    const where = `items[${index}] ("${item.title}")`;
    if (!item.prerequisiteFor) {
      errors.push(
        `${where} delivers nothing from the slice: list it in coverage, or, if it is a technical prerequisite, set prerequisiteFor and make a later item depend on it`,
      );
    } else if (!isNeededByLaterItem(position)) {
      errors.push(`${where} has prerequisiteFor, but no later item lists ${position} in dependsOn`);
    }
  });
}

/** "An item may depend only on items before it", phrased for the item at `position`. */
function earlierItemsHint(position: number): string {
  return position > 1 ? `items 1–${position - 1}` : "nothing (it is the first item)";
}

/**
 * Checks a product owner's proposal beyond its schema: delivery order, size limits, unique titles,
 * coverage, and answers to the notes assigned to the run.
 */
export function checkRefineOutput(limits: Config["refine"], out: RefineOutput, assignedNotes: readonly string[]): string[] {
  const errors: string[] = [];
  const itemCount = out.items.length;
  if (itemCount > limits.maxItems) {
    errors.push(
      `items: ${itemCount} items, the limit is ${limits.maxItems} (refine.maxItems). The slice is too big: propose in summary how to split it into smaller slices.`,
    );
  }

  const titles = new Map<string, number>();
  out.items.forEach((item, index) => {
    const position = index + 1;
    const where = `items[${index}] ("${item.title}")`;
    if (item.acceptanceCriteria.length > limits.maxCriteriaPerItem) {
      errors.push(
        `${where}: ${item.acceptanceCriteria.length} acceptance criteria, the limit is ${limits.maxCriteriaPerItem} (refine.maxCriteriaPerItem). Split the item.`,
      );
    }
    for (const dependency of item.dependsOn) {
      if (dependency >= position) {
        errors.push(
          `${where}.dependsOn: ${dependency} is not an earlier item. Items are listed in delivery order, so this one may depend on ${earlierItemsHint(position)}.`,
        );
      }
    }
    const titleKey = item.title.trim().toLowerCase();
    const firstWithTitle = titles.get(titleKey);
    if (firstWithTitle !== undefined) errors.push(`${where}: the same title as item ${firstWithTitle}; titles must be unique`);
    else titles.set(titleKey, position);
  });

  out.coverage.forEach((entry, index) => {
    for (const reference of entry.items) {
      if (reference > itemCount) errors.push(`coverage[${index}].items: ${reference} is not an item position (1–${itemCount})`);
    }
  });
  checkItemPurpose(out, errors);

  const answered = new Set(out.addressedNotes.map((answer) => answer.noteId));
  for (const noteId of assignedNotes) if (!answered.has(noteId)) errors.push(`addressedNotes: missing ${noteId}`);
  for (const noteId of answered) if (!assignedNotes.includes(noteId)) errors.push(`addressedNotes: ${noteId} was not assigned to this run`);
  return errors;
}
