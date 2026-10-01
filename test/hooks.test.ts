import * as path from "node:path";
import { describe, expect, it } from "vitest";
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
  permissionDecision,
  runAt,
  state,
  TASK,
  tmpDir,
  toReadyForCoding,
  toReadyForTests,
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
