/** The text an agent receives from `aw <role> start`: everything it needs for this run, and nothing it doesn't. */
import * as path from "node:path";
import type { ReviewerRun, Run, TaskState } from "../schema/state";
import type { Role } from "../schema/status";
import { readTextIfExists } from "../util/fsx";
import { describeGate } from "./gates";
import {
  currentPlan,
  describeFinding,
  latestSubmittedReview,
  latestSubmittedTester,
  openBlockingFindings,
  protectedTests,
  submittedRuns,
} from "./machine";
import { readPluginTemplate } from "./pluginFiles";
import { type Ctx, rel } from "./project";
import { type TaskRef, taskPaths } from "./store";
import { directTestCommandsBlocked } from "./tests";

/**
 * A notes/template text as agents should see it: HTML comments (template instructions) removed,
 * headings whose section is empty dropped. null when nothing is left.
 */
export function cleanNotes(text: string): string | null {
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const kept: string[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const keepSectionIfFilled = () => {
    if (body.some((line) => line.trim())) kept.push(...(heading ? [heading] : []), ...body);
    body = [];
  };
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      keepSectionIfFilled();
      heading = line;
    } else body.push(line);
  }
  keepSectionIfFilled();
  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result || null;
}

/** Repository-specific notes (.claude/aw/<name>.md) as agents should see them. */
export function readRoleNotes(ctx: Ctx, name: string): string | null {
  const text = readTextIfExists(path.join(ctx.roleNotesDir, `${name}.md`));
  return text ? cleanNotes(text) : null;
}

/**
 * Code standards for everyone who writes or reviews code: the plugin's defaults, then the repository's own rules
 * (.claude/aw/code-standards.md), which win where they conflict.
 */
function codeStandardsSection(ctx: Ctx, h: H, out: string[]): void {
  const defaults = cleanNotes(readPluginTemplate("code-standards.md") ?? "");
  const repositoryRules = readRoleNotes(ctx, "code-standards");
  if (!defaults && !repositoryRules) return;
  h("Code standards");
  if (defaults) out.push(defaults);
  if (repositoryRules) {
    // One level down, so the repository's headings nest under "## Code standards".
    const nested = repositoryRules.replace(/^(#{1,5}) /gm, "#$1 ");
    out.push("", "Repository rules (they win where they conflict with the above):", nested);
  }
}

export const awCmd = (args: string) => `aw ${args}`;

export function buildBriefing(ctx: Ctx, ref: TaskRef, s: TaskState, run: Run): string {
  const p = taskPaths(ref);
  const plan = currentPlan(s);
  const out: string[] = [];
  const h = (title: string) => out.push("", `## ${title}`);
  const roleLabel = run.role === "reviewer" ? `reviewer (${(run as ReviewerRun).target} review)` : run.role;

  out.push(
    `# aw briefing · ${roleLabel} · task ${s.id} · run ${run.id} (iteration ${run.iteration})`,
    "",
    `Status is now ${s.status} — you may start working.`,
    `Task: ${s.title}`,
    `Mode: ${s.mode}. Write all free-text fields in: ${ctx.config.language}.`,
  );

  h("Read first");
  out.push(
    `- Requirements (the task as given, verbatim): ${rel(ctx, p.requirements)}`,
    `- Plan (revision ${plan?.revision ?? "?"}, approved): ${rel(ctx, p.plan)} — ${planReadingHint(run.role)}`,
    "- Project instructions (CLAUDE.md) are already in your context; follow them.",
  );
  if (plan?.relevantDocs.length) {
    out.push("- Docs the plan points to (read the ones relevant to your work):");
    for (const d of plan.relevantDocs) out.push(`  - ${d.path} — ${d.why}`);
  }

  h("Acceptance criteria");
  for (const ac of plan?.acceptanceCriteria ?? []) out.push(`- ${ac.id}: ${ac.text}`);

  if (run.role === "tester") testerSection(ctx, s, run, h, out);
  if (run.role === "coder") coderSection(ctx, ref, s, run, h, out);
  if (run.role === "reviewer") reviewerSection(ctx, s, run as ReviewerRun, h, out);

  mustAddress(s, run, h, out);
  codeStandardsSection(ctx, h, out);

  const notes = readRoleNotes(ctx, run.role);
  if (notes) {
    h(`Repository notes for the ${run.role}`);
    out.push(notes);
  }

  h("Your output");
  const gates = run.role === "tester" ? ctx.config.gates.afterTests : run.role === "coder" ? ctx.config.gates.afterCoding : [];
  out.push(
    `1. Write your result as JSON to: ${run.outputFile}`,
    `   Format: run \`${awCmd(`schema ${run.role}`)}\` (JSON Schema + example). Do not invent IDs — reference only IDs shown in this briefing.`,
    `2. Run \`${awCmd(`${run.role} submit`)}\`. It validates the file${
      gates.length ? ` and runs gates: ${gates.map((g) => `${g.run} (expect ${g.expect})`).join(", ")}` : ""
    }. On errors, fix the cause and submit again (max ${ctx.config.limits.maxSubmitAttempts} attempts).`,
    `3. If you cannot finish (contradictory requirements, impossible plan, broken environment): \`${awCmd(`${run.role} fail --reason "<why>"`)}\`.`,
    `4. Final reply: ONE line, e.g. \`${run.role} ${run.id}: submitted — <≤15 words>\`. Details belong in the JSON, not in the reply.`,
  );
  return out.join("\n");
}

type H = (title: string) => void;

/**
 * What the agent still needs from plan.md. The tester's and coder's briefings already carry the criteria
 * and their part of the plan (contract, test strategy, implementation steps), so reading the whole plan
 * again would only repeat them; the reviewer's briefing carries just the criteria.
 */
function planReadingHint(role: Role): string {
  if (role === "reviewer") return "the acceptance criteria are below; read the contract, out-of-scope items and risks there.";
  return "the acceptance criteria and the parts of the plan you need are below; open it only for the summary, out-of-scope items and risks.";
}

function testerSection(ctx: Ctx, s: TaskState, run: Run, h: H, out: string[]): void {
  const plan = currentPlan(s);
  if (plan?.contract.trim()) {
    h("Contract (write tests against this interface)");
    out.push(plan.contract.trim());
  }
  if (plan?.testStrategy.trim()) {
    h("Test strategy from the plan");
    out.push(plan.testStrategy.trim());
  }
  h("Your job");
  out.push(
    "Write tests for the acceptance criteria BEFORE the implementation exists. They must fail now, for the right reason (missing behavior), and pass once the contract is implemented correctly.",
    "You write tests only — never the feature under test, anywhere (not in a scratch copy either). The coder builds it; your tests are the contract it must satisfy.",
    `You may only create or edit files matching tests.globs: ${ctx.config.tests.globs.join(", ")}. Other writes are blocked.`,
    "Map every test to the criteria it verifies (`covers`) and mark edge cases. Every criterion must be covered or listed in `untestedCriteria` with a reason.",
    testsHowTo(ctx, "tester"),
  );
  const prev = latestSubmittedTester(s);
  if (run.iteration > 1 && prev?.output) {
    h(`Your previous tests (run ${prev.id})`);
    for (const t of prev.output.tests) out.push(`- ${t.id} ${t.file} — ${t.title}`);
  }
}

function coderSection(ctx: Ctx, ref: TaskRef, s: TaskState, run: Run, h: H, out: string[]): void {
  const plan = currentPlan(s);
  if (plan?.contract.trim()) {
    h("Contract");
    out.push(plan.contract.trim());
  }
  h("Implementation steps from the plan");
  for (const step of plan?.approach ?? []) out.push(`- ${step}`);

  h("Your job");
  if (s.mode === "tdd") {
    out.push("Implement the plan so that the protected tests pass. Do not change the protected test files — edits are blocked and checked at submit.");
    const tests = protectedTests(s);
    if (tests.length) {
      out.push("", "Tests to make pass:");
      for (const t of tests) out.push(`- ${t.id} [${t.kind}${t.edgeCase ? ", edge" : ""}; ${t.covers.join(", ")}] ${t.file} — ${t.title}`);
    }
    if (s.protectedFiles.length) {
      out.push("", `Protected files (originals in ${rel(ctx, taskPaths(ref).protected)}):`);
      for (const f of s.protectedFiles) out.push(`- ${f.path}`);
    }
    out.push(
      "",
      "If you are convinced a protected test is wrong, don't work around it: explain it in `testDisputes` and submit — a human decides.",
      "If the tests miss a case the requirements need, add a test for it in a new file (list it in `testsAdded`) and describe the gap in `processNotes`.",
    );
  } else {
    out.push(
      "Light mode: there is no separate tester. Implement the plan AND write tests for it. List them in `testsAdded` (with `covers`); every criterion must be covered or listed in `untestedCriteria`.",
    );
  }
  if (ctx.config.docs.length) {
    out.push("", "Documentation index — update what your change affects and list it in `docsUpdated`:");
    for (const d of ctx.config.docs) out.push(`- ${d.path} — ${d.when}`);
  }
  out.push("", testsHowTo(ctx, "coder"));
  out.push("", "Do not commit, push, stash or switch branches. The user reviews and commits.");
  if (run.iteration > 1) {
    const prev = submittedRuns(s, "coder").at(-1);
    if (prev) out.push(`This is iteration ${run.iteration}; your previous submission was ${prev.id}.`);
  }
}

function reviewerSection(ctx: Ctx, s: TaskState, run: ReviewerRun, h: H, out: string[]): void {
  h("Your job");
  if (run.target === "tests") {
    const tester = latestSubmittedTester(s);
    out.push(
      "Review the TESTS written from the requirements. No implementation exists yet — that's expected.",
      "Check: every criterion really verified (not just mentioned); edge cases and error paths; tests assert behavior through the contract, not internals;",
      "would an obviously wrong implementation still pass?; test independence and determinism; repo test conventions; nothing outside test files;",
      "a rule shared by several endpoints or functions tested in full only once (elsewhere one representative case), not as a duplicated matrix.",
    );
    if (tester?.output) {
      h(`Tests to review (tester run ${tester.id})`);
      for (const t of tester.output.tests) {
        out.push(`- ${t.id} [${t.kind}${t.edgeCase ? ", edge" : ""}; ${t.covers.join(", ")}] ${t.file} — ${t.title}`);
      }
      if (tester.output.supportFiles.length) out.push(`Support files: ${tester.output.supportFiles.join(", ")}`);
      for (const u of tester.output.untestedCriteria) out.push(`- Untested by design: ${u.ac} — ${u.reason}`);
      tester.gates.forEach((g) => out.push(`- Gate ${describeGate(g)}`));
      tester.warnings.forEach((w) => out.push(`- Warning: ${w}`));
      notesToVerify(s, tester, h, out);
    }
  } else {
    const coder = submittedRuns(s, "coder").at(-1);
    out.push(
      "Review the IMPLEMENTATION against the requirements, the plan and the tests.",
      s.git.baseRef
        ? `See the change with \`git diff ${s.git.baseRef}\` plus \`git status --porcelain\` (untracked files are new).`
        : "The repository has no git base commit recorded; use the coder's filesChanged list below.",
    );
    if (s.git.dirtyAtStart) {
      out.push("Note: the working tree already had uncommitted changes when the task started — separate them using the coder's filesChanged list.");
    }
    if (coder?.role === "coder" && coder.output) {
      h(`Coder's report (run ${coder.id})`);
      out.push(coder.output.summary);
      for (const f of coder.output.filesChanged) out.push(`- ${f.change}: ${f.path} — ${f.why}`);
      for (const d of coder.output.decisions) out.push(`- Decision: ${d.decision} — ${d.rationale}`);
      for (const d of coder.output.deviationsFromPlan) out.push(`- Deviation from plan: ${d.what} — ${d.why}`);
      for (const a of coder.output.addressedFindings) out.push(`- Addressed ${a.findingId} (${a.resolution}): ${a.note}`);
      for (const d of coder.output.docsUpdated) out.push(`- Docs updated: ${d.path} — ${d.what}`);
      for (const t of coder.output.testsAdded) out.push(`- Test added: ${t.file} — ${t.title}`);
      coder.gates.forEach((g) => out.push(`- Gate ${describeGate(g)}`));
      coder.warnings.forEach((w) => out.push(`- Warning: ${w}`));
      notesToVerify(s, coder, h, out);
    }
  }
  out.push("", testsHowTo(ctx, "reviewer"));
  h("Severity rules");
  out.push(
    "- blocker: wrong behavior vs requirements, data loss, security hole, crash, broken build/tests.",
    "- major: likely bug on an edge case, missing coverage of a criterion, contract/API break, a maintainability cost that is concrete NOW (needs `evidence`).",
    "- minor / nit: worth fixing but not blocking. Ideas for later go to `followUps`, not to findings.",
    "Only blocker/major send the work back. Verdict must be consistent: approve ⇔ no blocking findings and no not_fixed previous findings.",
  );
  const prevReview = latestSubmittedReview(s, run.target);
  if (prevReview) out.push("", `Your previous review of the ${run.target} was run ${prevReview.id}.`);
}

/** How a role runs tests. Each full run costs about a minute in a real project, so repeats are what make runs slow. */
const TESTS_HOW_TO: Record<Role, string> = {
  tester:
    'Run your tests with `aw test` (it finds this task\'s test files; narrow with -t "<test name>" or pass files). Running them to see that they fail for the right reason is all the checking you do.',
  coder:
    'Running tests: use `aw test` narrowed to what you are working on (-t "<describe or test name>", or pass files). Don\'t run the whole suite yourself — submit runs it once as a gate and shows you any failures.',
  reviewer:
    'Tests: the gate results above were produced by the CLI and are authoritative — don\'t re-run the suite. To check a specific suspicion, run it narrowly: `aw test -t "<test name>"` (or pass files).',
};

const DIRECT_TEST_COMMANDS_BLOCKED = " Direct test-runner commands (npm test, npx vitest, …) are blocked for aw agents.";

function testsHowTo(ctx: Ctx, role: Role): string {
  return TESTS_HOW_TO[role] + (directTestCommandsBlocked(ctx.config) ? DIRECT_TEST_COMMANDS_BLOCKED : "");
}

/** Notes (user feedback, docs gaps, dispute decisions) the reviewed agent had to address, with its answers. */
function notesToVerify(s: TaskState, reviewed: Run, h: H, out: string[]): void {
  const notes = s.notes.filter((n) => reviewed.consumedNotes.includes(n.id));
  if (!notes.length || !reviewed.output) return;
  const answers = "addressedNotes" in reviewed.output ? reviewed.output.addressedNotes : [];
  h(`Notes the ${reviewed.role} had to address — verify each; a note not really handled is a blocking finding (category "requirements")`);
  for (const n of notes) {
    const answer = answers.find((a) => a.noteId === n.id)?.note ?? "(no answer)";
    out.push(`- ${n.id} (${n.source}): ${n.text}`, `  ${reviewed.role}'s answer: ${answer}`);
  }
}

const LINE_HINT =
  "Line numbers are hints from the time of the review — the code may have changed since. Locate by file + symbol (in parentheses) and the message.";

function mustAddress(s: TaskState, run: Run, h: H, out: string[]): void {
  const findings =
    run.role === "tester" ? openBlockingFindings(s, "tests")
    : run.role === "coder" ? openBlockingFindings(s, "code")
    : [];
  const notes = s.notes.filter((n) => run.consumedNotes.includes(n.id));
  if (run.role === "reviewer") {
    const open = openBlockingFindings(s, (run as ReviewerRun).target);
    if (open.length) {
      h("Verify previous findings (give each a status in `previousFindings`)");
      out.push(LINE_HINT);
      for (const f of open) out.push(`- ${describeFinding(f)}`);
    }
    if (notes.length) {
      h("Notes from the orchestrator");
      for (const n of notes) out.push(`- ${n.id} (${n.source}): ${n.text}`);
    }
    return;
  }
  if (!findings.length && !notes.length) return;
  h("Must address (each needs an entry in addressedFindings / addressedNotes)");
  if (findings.length) out.push(LINE_HINT);
  for (const f of findings) out.push(`- ${describeFinding(f)}`);
  for (const n of notes) out.push(`- ${n.id} (${n.source}): ${n.text}`);
}
