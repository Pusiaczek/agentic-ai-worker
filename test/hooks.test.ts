import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_OWNER_AGENT } from "../src/commands/refine";
import { findAwInvocations, splitSegments } from "../src/hooks/shell";
import {
  additionalContext,
  bashCall,
  CODER_OUT,
  cli,
  editCall,
  expectOk,
  hook,
  makeProject,
  outFile,
  PROPOSAL,
  permissionDecision,
  refinement,
  runAt,
  SLICE,
  sliceFile,
  state,
  TASK,
  tmpDir,
  toProposedRefinement,
  toReadyForCoding,
  toReadyForTests,
  toWorkingRefinement,
  write,
} from "./helpers";

describe("shell parsing", () => {
  it("splits on unquoted operators and keeps redirections", () => {
    expect(splitSegments(`grep "a|b" x && FOO=1 npm test 2>&1 | tail -5; echo 'x;y'`)).toEqual([
      `grep "a|b" x`,
      "npm test 2>&1",
      "tail -5",
      "echo 'x;y'",
    ]);
  });

  it("finds aw invocations in all forms", () => {
    expect(findAwInvocations(`node "C:\\Users\\x\\aw.mjs" coder start`)).toEqual([{ sub: "coder", action: "start" }]);
    expect(findAwInvocations(`bash -c "aw sm approve"`)).toEqual([{ sub: "sm", action: "approve" }]);
    expect(findAwInvocations(`/opt/plugin/bin/aw tester submit && echo draw sm`)).toEqual([{ sub: "tester", action: "submit" }]);
  });
});

describe("pre-tool-use guards", () => {
  it("stays out of repositories without aw, except for stopping aw's own agents", () => {
    const dir = tmpDir();
    expect(hook(dir, "pre-tool-use", editCall("src/a.js"))).toBeNull();
    expect(hook(dir, "pre-tool-use", editCall("src/a.js", "Explore"))).toBeNull();
    expect(hook(dir, "pre-tool-use", bashCall("rm -rf src"))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("src/a.js", "aw:coder")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("npm test", "aw:tester")))).toBe("deny");
    expect(hook(dir, "pre-tool-use", bashCall("aw coder start", "aw:coder"))).toBeNull(); // fails on its own: not initialized
    expect(hook(dir, "pre-tool-use", { tool_name: "Read", tool_input: { file_path: "a" }, agent_type: "aw:coder" })).toBeNull();
    expect(additionalContext(hook(dir, "subagent-start", { agent_type: "aw:coder" }))).toContain("not set up for aw");
  });

  it("keeps each role to its own aw commands and gates human decisions", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("aw sm approve", "aw:coder")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall(`bash -c "aw sm next"`, "aw:tester")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("aw reviewer start", "aw:coder")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("aw coder start", "aw:coder")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("aw coder start")))).toBe("deny"); // main session
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("aw sm approve")))).toBe("ask");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("aw sm next")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("aw hook pre-tool-use")))).toBe("deny");
  });

  it("protects state.json from everyone", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    const stateFile = path.join(dir, ".tasks", "active", TASK, "state.json");
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall(stateFile)))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall(`echo {} > ${stateFile}`)))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall(path.join(dir, ".tasks", "active", TASK, "plan.json"))))).toBeNull();
  });

  it("lets agents edit only during their own run, within their role", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("tests/a.test.js", "aw:tester")))).toBe("deny"); // not started
    expectOk(cli(dir, ["tester", "start"]));
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("tests/a.test.js", "aw:tester")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("src/impl.js", "aw:tester")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall(outFile(dir), "aw:tester")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("src/impl.js", "aw:coder")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("src/impl.js")))).toBe("deny"); // main session during a run
  });

  it("protects approved tests from the coder and keeps the reviewer read-only", () => {
    const dir = makeProject();
    toReadyForCoding(dir);
    expectOk(cli(dir, ["coder", "start"]));
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("tests/limit.test.js", "aw:coder")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("src/impl.js", "aw:coder")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("git push origin main", "aw:coder")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("npm install left-pad", "aw:coder")))).toBeNull();
    write(dir, "src/impl.js", "\n");
    write(dir, outFile(dir), CODER_OUT);
    expectOk(cli(dir, ["coder", "submit"]));
    expectOk(cli(dir, ["reviewer", "start"]));
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("git diff HEAD -- src && git status --porcelain", "aw:reviewer")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("git diff HEAD -- src && node check.cjs", "aw:reviewer")))).toBe("deny"); // test command
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall('aw test -t "PATCH"', "aw:reviewer")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("rm -rf src", "aw:reviewer")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall("src/impl.js", "aw:reviewer")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall(outFile(dir), "aw:reviewer")))).toBeNull();
  });
});

describe("subagent lifecycle hooks", () => {
  it("records the agent, blocks stopping before submit, then gives up", () => {
    const dir = makeProject({ limits: { stopBlocks: 1 } });
    toReadyForTests(dir);
    const start = hook(dir, "subagent-start", { agent_type: "aw:tester", agent_id: "agent-1" });
    expect(additionalContext(start)).toContain("aw tester start");
    expectOk(cli(dir, ["tester", "start"]));
    expect(runAt(state(dir), 0).agentId).toBe("agent-1");

    const stop = { agent_type: "aw:tester", agent_id: "agent-1", agent_transcript_path: "/t/agent-1.jsonl", last_assistant_message: "done" };
    const blocked = hook(dir, "subagent-stop", stop);
    expect(blocked?.decision).toBe("block");
    expect(blocked?.reason).toContain("aw tester submit");
    expect(hook(dir, "subagent-stop", stop)).toBeNull();
    const run = runAt(state(dir), 0);
    expect(run.stoppedWithoutSubmit).toBe(true);
    expect(run.transcriptPath).toBe("/t/agent-1.jsonl");
    expect(expectOk(cli(dir, ["sm", "next"])).out).toContain("NEXT: recover-agent");
  });

  it("asks once for a shorter final reply", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    hook(dir, "subagent-start", { agent_type: "aw:tester", agent_id: "agent-2" });
    expectOk(cli(dir, ["tester", "start"]));
    write(dir, "tests/limit.test.js", "//\n");
    write(dir, outFile(dir), {
      summary: "t",
      tests: [{ file: "tests/limit.test.js", title: "a", kind: "unit", covers: ["AC-1", "AC-2"], edgeCase: true }],
    });
    expectOk(cli(dir, ["tester", "submit"]));
    const long = { agent_type: "aw:tester", agent_id: "agent-2", last_assistant_message: "x".repeat(2000) };
    expect(hook(dir, "subagent-stop", long)?.decision).toBe("block");
    expect(hook(dir, "subagent-stop", long)).toBeNull();
  });

  it("points the orchestrator at the state after an agent call", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    const afterAgent = hook(dir, "post-tool-use", { tool_name: "Agent", tool_input: { subagent_type: "aw:tester" } });
    expect(additionalContext(afterAgent)).toContain("run `aw sm next`");
    expect(hook(dir, "post-tool-use", { tool_name: "Agent", tool_input: { subagent_type: "Explore" } })).toBeNull();
  });

  it("recommends resuming the coder and a fresh reviewer", () => {
    const dir = makeProject();
    toReadyForCoding(dir);
    hook(dir, "subagent-start", { agent_type: "aw:coder", agent_id: "coder-1" });
    expectOk(cli(dir, ["coder", "start"]));
    write(dir, "src/impl.js", "\n");
    write(dir, outFile(dir), CODER_OUT);
    expectOk(cli(dir, ["coder", "submit"]));
    expect(expectOk(cli(dir, ["sm", "next"])).out).toContain("HOW: spawn a fresh aw:reviewer");
    expectOk(cli(dir, ["reviewer", "start"]));
    write(dir, outFile(dir), {
      summary: "r",
      verdict: "changes_requested",
      acCoverage: [{ ac: "AC-1", verdict: "covered" }, { ac: "AC-2", verdict: "missing" }],
      findings: [{ severity: "major", category: "requirements", message: "AC-2 missing" }],
    });
    expectOk(cli(dir, ["reviewer", "submit"]));
    expect(expectOk(cli(dir, ["sm", "next"])).out).toContain("HOW: resume agent coder-1");
  });
});

describe("read-only shell for the reviewer", () => {
  it("lets the reviewer look but not write files or run other programs", () => {
    const dir = makeProject();
    const reviewerRuns = (command: string) => permissionDecision(hook(dir, "pre-tool-use", bashCall(command, "aw:reviewer")));

    const reading = [
      "git diff HEAD~1",
      'grep -rn "a > b" src',
      "find src -name '*.ts' 2>/dev/null | head -5",
      "ls -la",
      "cat src/app.ts 2>&1",
      "git ls-remote --tags https://github.com/actions/checkout",
      "npm view vitest versions",
    ];
    for (const command of reading) expect(reviewerRuns(command)).toBeNull();
    const writing = [
      "find . -delete",
      "find . -name x -exec rm {} \\;",
      "git diff --output=patch.txt",
      "cat src/a.ts > src/b.ts",
      'grep "$(rm -rf src)" a.ts',
      "tree -o listing.txt",
      "rg --pre ./x.sh foo",
      "echo hi >> notes.md",
      "git ls-remote -u ./evil.sh origin",
      "git ls-remote --upload-pack=./evil.sh origin",
      "grep --pager=less x src",
      'node -e "process.exit(0)" --fix', // the repository's lint command, told to fix files
    ];
    for (const command of writing) expect(reviewerRuns(command)).toBe("deny");
  });
});

describe("product owner guards", () => {
  /** The PreToolUse verdict for a Bash call by the product owner. */
  const productOwnerRuns = (dir: string, command: string) => permissionDecision(hook(dir, "pre-tool-use", bashCall(command, PRODUCT_OWNER_AGENT)));
  /** The PreToolUse verdict for an edit by the product owner. */
  const productOwnerEdits = (dir: string, file: string) => permissionDecision(hook(dir, "pre-tool-use", editCall(file, PRODUCT_OWNER_AGENT)));

  it("lets the product owner write only the proposal of the refinement in progress", () => {
    const dir = makeProject();
    write(dir, "orders.md", "Orders.\n");
    expectOk(cli(dir, ["refine", "new", "--title", "Orders", "--id", "orders", "--input", "orders.md"]));
    expect(productOwnerEdits(dir, PROPOSAL)).toBe("deny"); // no product owner run yet
    toWorkingRefinement(dir);

    expect(productOwnerEdits(dir, PROPOSAL)).toBeNull();
    expect(productOwnerEdits(dir, path.join(dir, PROPOSAL))).toBeNull();
    for (const file of ["src/users.ts", sliceFile("input.md"), ".tasks/refinements/orders/proposal.json"]) {
      expect(productOwnerEdits(dir, file)).toBe("deny");
    }
  });

  it("lets the product owner run only `aw refine submit`, `aw schema refine` and read-only searches", () => {
    const dir = makeProject();
    toWorkingRefinement(dir);

    const allowed = [
      "aw refine submit",
      "aw   schema refine",
      'node "C:/plugins/aw/cli/aw.mjs" refine submit 2>&1',
      "node 'C:/plugins/aw/cli/aw.mjs' schema refine",
      "C:/plugins/aw/bin/aw.cmd refine submit",
      'grep -rn "User" src',
      'find src -name "*.ts" 2>/dev/null | head -20',
      "ls docs/product",
    ];
    for (const command of allowed) expect(productOwnerRuns(dir, command)).toBeNull();
    const notAllowed = [
      `aw refine approve ${SLICE}`,
      "npm test",
      'python -c "aw refine submit"',
      "aw refine submit > out.txt",
      "aw refine submit --force",
      "node evil.mjs refine submit",
      "aw refine submit && rm -rf src",
      "find . -delete",
      "find . -name x -exec rm {} \\;",
      "grep -rn User src > users.txt",
      "grep x $(rm -rf src)",
      "cat src/app.ts",
    ];
    for (const command of notAllowed) expect(productOwnerRuns(dir, command)).toBe("deny");
  });

  it("keeps `aw refine` with the main session, gates the approval and protects refinement.json", () => {
    const dir = makeProject();
    toProposedRefinement(dir);
    const decision = (command: string, agentType?: string) => permissionDecision(hook(dir, "pre-tool-use", bashCall(command, agentType)));

    expect(decision("aw refine submit")).toBe("deny");
    expect(decision(`aw refine approve ${SLICE}`)).toBe("ask");
    expect(decision(`aw refine note ${SLICE} --text "Smaller items."`)).toBeNull();
    expect(decision(`aw refine note ${SLICE} --text "Smaller items."`, "aw:tester")).toBe("deny");
    expect(decision(`aw refine show ${SLICE}`, "Explore")).toBeNull();
    expect(decision(`aw refine cancel ${SLICE} --reason "No."`, "Explore")).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", editCall(sliceFile("refinement.json"))))).toBe("deny");
    expect(decision(`echo {} > ${sliceFile("refinement.sha256")}`)).toBe("deny");
  });

  it("stops the product owner in a repository without aw", () => {
    const dir = tmpDir();
    expect(productOwnerEdits(dir, "proposal.json")).toBe("deny");
    expect(additionalContext(hook(dir, "subagent-start", { agent_type: PRODUCT_OWNER_AGENT }))).toContain("not set up for aw");
  });
});

describe("product owner lifecycle hooks", () => {
  it("names the refinement, blocks stopping before submit, then gives up", () => {
    const dir = makeProject({ limits: { stopBlocks: 1 } });
    toWorkingRefinement(dir);

    const start = additionalContext(hook(dir, "subagent-start", { agent_type: PRODUCT_OWNER_AGENT, agent_id: "po-1" }));
    expect(start).toContain(`refinement ${SLICE} (run R-1)`);
    expect(start).toContain(sliceFile("briefing.md"));
    expect(refinement(dir).runs[0]?.agentId).toBe("po-1");

    const stop = { agent_type: PRODUCT_OWNER_AGENT, agent_id: "po-1", agent_transcript_path: "/t/po-1.jsonl" };
    const blocked = hook(dir, "subagent-stop", stop);
    expect(blocked?.decision).toBe("block");
    expect(blocked?.reason).toContain("aw refine submit");
    expect(hook(dir, "subagent-stop", stop)).toBeNull();
    expect(refinement(dir).runs[0]).toMatchObject({ stoppedWithoutSubmit: true, transcriptPath: "/t/po-1.jsonl" });
    expect(expectOk(cli(dir, ["refine", "next"])).out).toContain("and the agent stopped");
  });

  it("lets the product owner stop after an accepted proposal, and points the orchestrator at the state", () => {
    const dir = makeProject();
    toProposedRefinement(dir);

    expect(hook(dir, "subagent-stop", { agent_type: PRODUCT_OWNER_AGENT, agent_id: "po-1" })).toBeNull();
    const afterAgent = hook(dir, "post-tool-use", { tool_name: "Agent", tool_input: { subagent_type: PRODUCT_OWNER_AGENT } });
    expect(additionalContext(afterAgent)).toContain("run `aw refine next`");
  });

  it("tells a product owner spawned without a run that there is nothing to refine", () => {
    const start = hook(makeProject(), "subagent-start", { agent_type: PRODUCT_OWNER_AGENT });
    expect(additionalContext(start)).toContain("nothing to refine");
  });
});
