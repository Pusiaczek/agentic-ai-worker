import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Backlog, Run } from "../src/schema/state";
import {
  CODER_OUT,
  cli,
  coverage,
  expectOk,
  makeProject,
  outFile,
  readJson,
  runAt,
  runOfRole,
  state,
  TASK,
  taskDir,
  toReadyForCoding,
  toReadyForTests,
  write,
} from "./helpers";

describe("full tdd flow", () => {
  it("goes from intake to archive, keeping every run", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    expect(state(dir).status).toBe("READY_FOR_TESTS");
    expect(fs.readFileSync(path.join(taskDir(dir), "plan.md"), "utf8")).toContain("**AC-2** Success resets the counter.");

    // Tester: tests fail before implementation → red check ok, no warnings.
    expect(expectOk(cli(dir, ["tester", "start"])).out).toContain("never the feature under test");
    write(dir, "tests/limit.test.js", "// tests\n");
    write(dir, outFile(dir), {
      summary: "Two unit tests.",
      tests: [
        { file: "tests/limit.test.js", title: "blocks the 6th attempt", kind: "unit", covers: ["AC-1"], edgeCase: true },
        { file: "./tests/limit.test.js", title: "resets on success", kind: "unit", covers: ["AC-2"], edgeCase: false },
      ],
      processNotes: ["contract did not say what limit() returns"],
    });
    const testerSubmit = expectOk(cli(dir, ["tester", "submit"]));
    expect(testerSubmit.out).toContain("READY_FOR_TEST_REVIEW");
    expect(testerSubmit.out).toContain("testFiles: ok");
    const testerOutput = runOfRole(state(dir), 0, "tester").output;
    expect(testerOutput?.tests.map((test) => test.id)).toEqual(["T-1", "T-2"]);
    expect(testerOutput?.tests[1]?.file).toBe("tests/limit.test.js"); // normalized from "./tests/…"

    // Reviewer approves the tests → files are protected.
    const reviewTests = expectOk(cli(dir, ["reviewer", "start"]));
    expect(reviewTests.out).toContain("Review the TESTS");
    write(dir, outFile(dir), { summary: "Good.", verdict: "approve", acCoverage: coverage() });
    expectOk(cli(dir, ["reviewer", "submit"]));
    let s = state(dir);
    expect(s.status).toBe("READY_FOR_CODING");
    expect(s.protectedFiles.map((file) => file.path)).toEqual(["tests/limit.test.js"]);
    expect(fs.existsSync(path.join(dir, s.protectedFiles[0]!.snapshot))).toBe(true);

    // Coder implements; gates pass.
    const coderBrief = expectOk(cli(dir, ["coder", "start"]));
    expect(coderBrief.out).toContain("T-1 [unit, edge; AC-1] tests/limit.test.js");
    write(dir, "src/impl.js", "module.exports = {};\n");
    write(dir, outFile(dir), CODER_OUT);
    expect(expectOk(cli(dir, ["coder", "submit"])).out).toContain("READY_FOR_CODE_REVIEW");

    // Reviewer requests changes with one major finding and one follow-up.
    expectOk(cli(dir, ["reviewer", "start"]));
    write(dir, outFile(dir), {
      summary: "One bug.",
      verdict: "changes_requested",
      findings: [{ file: "src/impl.js", line: 1, symbol: "limit", severity: "major", category: "correctness", message: "does nothing" }],
      acCoverage: coverage("partial"),
      followUps: [{ text: "Use Redis later" }],
    });
    expectOk(cli(dir, ["reviewer", "submit"]));
    expect(state(dir).status).toBe("READY_FOR_CODING");

    // Coder iteration 2 must address F-1.
    const brief2 = expectOk(cli(dir, ["coder", "start"]));
    expect(brief2.out).toContain("Must address");
    expect(brief2.out).toContain("F-1 [major/correctness] src/impl.js:1 (limit) — does nothing");
    expect(brief2.out).toContain("Line numbers are hints");
    write(dir, outFile(dir), CODER_OUT);
    const rejected = cli(dir, ["coder", "submit"]);
    expect(rejected.code).toBe(4);
    expect(rejected.err).toContain("addressedFindings: missing F-1");
    write(dir, outFile(dir), { ...CODER_OUT, addressedFindings: [{ findingId: "F-1", resolution: "fixed", note: "implemented" }] });
    expectOk(cli(dir, ["coder", "submit"]));

    // Reviewer must give F-1 a status, then approves.
    expectOk(cli(dir, ["reviewer", "start"]));
    write(dir, outFile(dir), { summary: "Fixed.", verdict: "approve", acCoverage: coverage() });
    expect(cli(dir, ["reviewer", "submit"]).err).toContain("previousFindings: missing F-1");
    write(dir, outFile(dir), {
      summary: "Fixed.",
      verdict: "approve",
      acCoverage: coverage(),
      previousFindings: [{ id: "F-1", status: "fixed" }],
    });
    expectOk(cli(dir, ["reviewer", "submit"]));
    expect(state(dir).status).toBe("DOCS_CHECK");

    // Docs check, acceptance, archive.
    write(dir, "docs.json", { items: [{ path: "README.md", status: "not_needed", note: "no usage change" }], verdict: "ok" });
    expectOk(cli(dir, ["sm", "docs", "--file", "docs.json"]));
    expectOk(cli(dir, ["sm", "accept"]));
    s = state(dir);
    expect(s.status).toBe("DONE");
    const describeRun = (run: Run) => `${run.role}${run.role === "reviewer" ? `/${run.target}` : ""}:${run.state}`;
    expect(s.runs.map(describeRun)).toEqual([
      "tester:submitted",
      "reviewer/tests:submitted",
      "coder:submitted",
      "reviewer/code:submitted",
      "coder:submitted",
      "reviewer/code:submitted",
    ]);
    expect(runAt(s, 4).submitAttempts.map((attempt) => attempt.ok)).toEqual([false, true]);

    write(dir, "retro.json", { wentWell: ["tests first"], processImprovements: ["specify return values in the contract"] });
    const archived = expectOk(cli(dir, ["sm", "archive", "--retro", "retro.json"]));
    expect(archived.out).toContain("item(s) added to the backlog");
    expect(fs.existsSync(taskDir(dir))).toBe(false);
    const archiveDirs = fs.readdirSync(path.join(dir, ".tasks", "archive"));
    expect(archiveDirs).toHaveLength(1);
    const report = fs.readFileSync(path.join(dir, ".tasks", "archive", archiveDirs[0]!, "report.md"), "utf8");
    expect(report).toContain("F-1 [major/correctness]");
    expect(report).toContain("## Retro");

    const backlog = readJson<Backlog>(dir, ".tasks/backlog.json");
    expect(backlog.items.map((item) => item.kind).sort()).toEqual(["followUp", "processImprovement", "processNote"]);
    expect(expectOk(cli(dir, ["stats"])).out).toContain("Archived tasks: 1 (done 1, cancelled 0)");
    expect(expectOk(cli(dir, ["show", "--task", TASK])).out).toContain("Status: DONE");
    expect(expectOk(cli(dir, ["sm", "next"])).out).toContain("NEXT: intake");
  });

  it("light mode skips tester and approval, and requires the coder's own tests", () => {
    const dir = makeProject();
    expectOk(cli(dir, ["sm", "new", "--title", "Small fix", "--id", TASK, "--mode", "light"]));
    write(dir, `.tasks/active/${TASK}/requirements.md`, "Fix a typo.\n");
    write(dir, "plan.json", { mode: "light", summary: "Fix typo", acceptanceCriteria: ["Typo gone"], approach: ["edit"] });
    expectOk(cli(dir, ["sm", "plan", "--file", "plan.json"]));
    expect(state(dir).status).toBe("READY_FOR_CODING");
    expectOk(cli(dir, ["coder", "start"]));
    write(dir, "src/impl.js", "\n");
    write(dir, outFile(dir), CODER_OUT);
    expect(cli(dir, ["coder", "submit"]).err).toContain("AC-1 is neither covered");
    write(dir, outFile(dir), { ...CODER_OUT, untestedCriteria: [{ ac: "AC-1", reason: "text-only change" }] });
    expectOk(cli(dir, ["coder", "submit"]));
    expect(state(dir).status).toBe("READY_FOR_CODE_REVIEW");
  });
});

describe("code standards", () => {
  it("reach every role's briefing: aw defaults first, then the repository's own rules", () => {
    const dir = makeProject();
    write(dir, ".claude/aw/code-standards.md", "# Code standards for this repository\n\n## Rules\n<!-- template hint -->\n- Services return Result<T, E>.\n\n## Exceptions to the aw defaults\n<!-- empty -->\n");
    toReadyForTests(dir);
    const testerBriefing = expectOk(cli(dir, ["tester", "start"])).out;
    expect(testerBriefing).toContain("## Code standards");
    expect(testerBriefing).toContain("**No nested ternaries.**");
    expect(testerBriefing).toContain("Repository rules (they win where they conflict with the above):");
    expect(testerBriefing).toContain("### Rules"); // nested one level under "## Code standards"
    expect(testerBriefing).toContain("- Services return Result<T, E>.");
    expect(testerBriefing).not.toContain("template hint");
    expect(testerBriefing).not.toContain("Exceptions to the aw defaults"); // empty section dropped
  });
});

describe("user feedback after review", () => {
  it("routes each remark as a note the coder must answer and the reviewer must verify", () => {
    const dir = makeProject();
    toReadyForCoding(dir);
    expectOk(cli(dir, ["coder", "start"]));
    write(dir, "src/impl.js", "\n");
    write(dir, outFile(dir), CODER_OUT);
    expectOk(cli(dir, ["coder", "submit"]));
    expectOk(cli(dir, ["reviewer", "start"]));
    write(dir, outFile(dir), { summary: "ok", verdict: "approve", acCoverage: coverage() });
    expectOk(cli(dir, ["reviewer", "submit"]));
    write(dir, "docs.json", { items: [{ path: "README.md", status: "not_needed", note: "-" }], verdict: "ok" });
    expectOk(cli(dir, ["sm", "docs", "--file", "docs.json"]));
    expect(state(dir).status).toBe("AWAITING_ACCEPTANCE");

    const noNotes = cli(dir, ["sm", "reopen", "--to", "READY_FOR_CODING", "--note", "user feedback"]);
    expect(noNotes.code).toBe(2);
    expect(noNotes.err).toContain("aw sm note --for coder");

    expectOk(cli(dir, ["sm", "note", "--for", "coder", "--text", "rename limit() to hitLimit()"]));
    expectOk(cli(dir, ["sm", "note", "--for", "coder", "--text", "log blocked attempts"]));
    expectOk(cli(dir, ["sm", "reopen", "--to", "READY_FOR_CODING", "--note", "2 remarks from review"]));

    const brief = expectOk(cli(dir, ["coder", "start"]));
    expect(brief.out).toContain("N-1 (user): rename limit() to hitLimit()");
    expect(brief.out).toContain("N-2 (user): log blocked attempts");
    write(dir, outFile(dir), { ...CODER_OUT, addressedNotes: [{ noteId: "N-1", note: "renamed" }] });
    expect(cli(dir, ["coder", "submit"]).err).toContain("addressedNotes: missing N-2");
    write(dir, outFile(dir), {
      ...CODER_OUT,
      addressedNotes: [
        { noteId: "N-1", note: "renamed" },
        { noteId: "N-2", note: "added logger.warn" },
      ],
    });
    expectOk(cli(dir, ["coder", "submit"]));

    const review = expectOk(cli(dir, ["reviewer", "start"]));
    expect(review.out).toContain("Notes the coder had to address");
    expect(review.out).toContain("coder's answer: added logger.warn");
  });
});

describe("guards in the CLI", () => {
  it("refuses to start in the wrong status", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    const r = cli(dir, ["coder", "start"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("STATUS MISMATCH");
    expect(r.err).toContain("Do NOT do any work");
    expect(state(dir).status).toBe("READY_FOR_TESTS");
  });

  it("rejects invalid output and counts attempts up to the limit", () => {
    const dir = makeProject({ limits: { maxSubmitAttempts: 2 } });
    toReadyForTests(dir);
    expectOk(cli(dir, ["tester", "start"]));
    write(dir, outFile(dir), "{ not json");
    expect(cli(dir, ["tester", "submit"]).code).toBe(4);
    write(dir, outFile(dir), { summary: "x", tests: [], unknownField: 1 });
    const r = cli(dir, ["tester", "submit"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("Unrecognized key");
    expect(cli(dir, ["tester", "submit"]).err).toContain("attempt limit reached");
    expect(runAt(state(dir), 0).submitAttempts).toHaveLength(2);
  });

  it("rejects an approve verdict with a blocking finding", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    expectOk(cli(dir, ["tester", "start"]));
    write(dir, "tests/limit.test.js", "//\n");
    write(dir, outFile(dir), { summary: "t", tests: [{ file: "tests/limit.test.js", title: "a", kind: "unit", covers: ["AC-1", "AC-2"], edgeCase: true }] });
    expectOk(cli(dir, ["tester", "submit"]));
    expectOk(cli(dir, ["reviewer", "start"]));
    write(dir, outFile(dir), {
      summary: "r",
      verdict: "approve",
      acCoverage: coverage(),
      findings: [{ severity: "blocker", category: "tests", message: "AC-2 not really asserted" }],
    });
    expect(cli(dir, ["reviewer", "submit"]).err).toContain('verdict "approve" with 1 blocker/major');
  });

  it("requires evidence for blocking maintainability findings", () => {
    const dir = makeProject();
    toReadyForCoding(dir);
    expectOk(cli(dir, ["coder", "start"]));
    write(dir, "src/impl.js", "\n");
    write(dir, outFile(dir), CODER_OUT);
    expectOk(cli(dir, ["coder", "submit"]));
    expectOk(cli(dir, ["reviewer", "start"]));
    write(dir, outFile(dir), {
      summary: "r",
      verdict: "changes_requested",
      acCoverage: coverage(),
      findings: [{ severity: "major", category: "maintainability", message: "might need to be generic someday" }],
    });
    expect(cli(dir, ["reviewer", "submit"]).err).toContain("needs concrete evidence");
  });

  it("detects modified protected tests and failing gates", () => {
    const dir = makeProject();
    toReadyForCoding(dir);
    expectOk(cli(dir, ["coder", "start"]));
    write(dir, outFile(dir), CODER_OUT);
    const noImpl = cli(dir, ["coder", "submit"]);
    expect(noImpl.code).toBe(4);
    expect(noImpl.err).toContain("gate(s) failed");

    write(dir, "src/impl.js", "\n");
    write(dir, "tests/limit.test.js", "// weakened\n");
    const tampered = cli(dir, ["coder", "submit"]);
    expect(tampered.err).toContain("protected test file was modified: tests/limit.test.js");
  });

  it("blocks the task on a test dispute and routes the decision back", () => {
    const dir = makeProject();
    toReadyForCoding(dir);
    expectOk(cli(dir, ["coder", "start"]));
    write(dir, outFile(dir), { ...CODER_OUT, testDisputes: [{ testId: "T-2", reason: "contradicts AC-2" }] });
    expectOk(cli(dir, ["coder", "submit"]));
    let s = state(dir);
    expect(s.status).toBe("BLOCKED");
    expect(s.blocked?.reason).toContain("test dispute: T-2");
    expectOk(cli(dir, ["sm", "unblock", "--to", "READY_FOR_TESTS", "--note", "T-2 is wrong, fix it"]));
    s = state(dir);
    expect(s.notes.at(-1)).toMatchObject({ forRole: "tester", source: "dispute" });
    expect(expectOk(cli(dir, ["sm", "next"])).out).toContain("AGENT: aw:tester");
  });

  it("detects a hand-edited state file and repairs it on request", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    const file = path.join(taskDir(dir), "state.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"READY_FOR_TESTS"', '"READY_FOR_CODING"'));
    const r = cli(dir, ["sm", "next"]);
    expect(r.code).toBe(5);
    expect(r.err).toContain("modified outside the aw CLI");
    expectOk(cli(dir, ["sm", "repair"]));
    expect(state(dir).history.at(-1)).toMatchObject({ type: "event", event: "state_repaired" });
  });

  it("reset discards an unfinished run and re-queues its notes", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    expectOk(cli(dir, ["sm", "note", "--for", "tester", "--text", "cover unicode IPs"]));
    expectOk(cli(dir, ["tester", "start"]));
    expect(state(dir).notes[0]?.consumedByRun).toBe("R-1");
    expectOk(cli(dir, ["sm", "reset", "--note", "agent crashed"]));
    const s = state(dir);
    expect(s.status).toBe("READY_FOR_TESTS");
    expect(runAt(s, 0).state).toBe("abandoned");
    expect(s.notes[0]?.consumedByRun).toBeUndefined();
  });

  it("enforces the iteration limit", () => {
    const dir = makeProject({ limits: { maxCodeIterations: 1 } });
    toReadyForCoding(dir);
    expectOk(cli(dir, ["coder", "start"]));
    write(dir, "src/impl.js", "\n");
    write(dir, outFile(dir), CODER_OUT);
    expectOk(cli(dir, ["coder", "submit"]));
    expectOk(cli(dir, ["reviewer", "start"]));
    write(dir, outFile(dir), {
      summary: "r",
      verdict: "changes_requested",
      acCoverage: coverage(),
      findings: [{ severity: "blocker", category: "correctness", message: "wrong" }],
    });
    expectOk(cli(dir, ["reviewer", "submit"]));
    expect(state(dir).status).toBe("BLOCKED");
    expect(expectOk(cli(dir, ["sm", "next"])).out).toContain("NEXT: resolve-block");
  });

  it("tdd plans need a contract and requirements", () => {
    const dir = makeProject();
    expectOk(cli(dir, ["sm", "new", "--title", "x", "--id", TASK]));
    write(dir, "plan.json", { mode: "tdd", summary: "s", acceptanceCriteria: ["a"], approach: ["b"] });
    expect(cli(dir, ["sm", "plan", "--file", "plan.json"]).err).toContain("requirements.md is empty");
    write(dir, `.tasks/active/${TASK}/requirements.md`, "do x\n");
    expect(cli(dir, ["sm", "plan", "--file", "plan.json"]).err).toContain("tdd mode needs a contract");
  });
});
