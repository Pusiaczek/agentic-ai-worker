import { describe, expect, it } from "vitest";
import {
  bashCall,
  CODER_OUT,
  cli,
  expectOk,
  hook,
  makeProject,
  outFile,
  permissionDecision,
  runById,
  state,
  toReadyForCoding,
  toReadyForTests,
  write,
} from "./helpers";

describe("aw test", () => {
  it("runs the task's test files, narrows with -t, and records each run on the active run", () => {
    const dir = makeProject();
    toReadyForCoding(dir);
    expectOk(cli(dir, ["coder", "start"]));

    const red = cli(dir, ["test"]);
    expect(red.code).toBe(1);
    expect(red.out).toContain("aw test · 1 file(s) · FAILED (exit 1)");
    expect(red.out).toContain("$ node check.cjs tests/limit.test.js");
    expect(red.out).toMatch(/Full log: \.tasks\/active\/T-1\/logs\/R-3-test-\d+\.log/);

    write(dir, "src/impl.js", "module.exports = {};\n");
    const green = expectOk(cli(dir, ["test", "-t", "blocks the 6th"]));
    expect(green.out).toContain('filter "blocks the 6th" · passed');
    expect(green.out).toContain('$ node check.cjs tests/limit.test.js -t "blocks the 6th"');

    const recorded = runById(state(dir), "R-3").testRuns.map((testRun) => [testRun.exitCode, testRun.files, testRun.pattern]);
    expect(recorded).toEqual([
      [1, 1, undefined],
      [0, 1, "blocks the 6th"],
    ]);

    write(dir, outFile(dir), CODER_OUT);
    expectOk(cli(dir, ["coder", "submit"]));
    expect(expectOk(cli(dir, ["show"])).out).toContain("R-3 coder #1 submitted");
  });

  it("uses commands.testFiltered for runners whose name filter isn't -t", () => {
    const dir = makeProject({
      commands: {
        test: "node check.cjs",
        testFiles: "node check.cjs {files}",
        testFiltered: "node check.cjs {files} --grep {pattern}",
        lint: 'node -e "process.exit(0)"',
      },
    });
    toReadyForCoding(dir);
    const result = cli(dir, ["test", "-t", "resets"]);
    expect(result.out).toContain('$ node check.cjs tests/limit.test.js --grep "resets"');
  });

  it("needs files when there is no active task, and accepts explicit files", () => {
    const dir = makeProject();
    const noTask = cli(dir, ["test"]);
    expect(noTask.code).toBe(2);
    expect(noTask.err).toContain("No active task");
    write(dir, "tests/a.test.js", "//\n");
    write(dir, "src/impl.js", "\n");
    expect(expectOk(cli(dir, ["test", "tests/a.test.js"])).out).toContain("aw test · 1 file(s) · passed");
  });
});

describe("direct test commands", () => {
  it("are blocked for aw agents, who are pointed at aw test", () => {
    const dir = makeProject();
    toReadyForTests(dir);
    const denial = hook(dir, "pre-tool-use", bashCall("npm test", "aw:coder"));
    expect(permissionDecision(denial)).toBe("deny");
    expect(denial?.hookSpecificOutput?.permissionDecisionReason).toContain("aw test");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("npx vitest run test/a.test.ts", "aw:tester")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("npm run test:unit", "aw:coder")))).toBe("deny");
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("node check.cjs tests/x.test.js", "aw:coder")))).toBe("deny"); // commands.testFiles
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall('aw test -t "PATCH"', "aw:coder")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("npm install left-pad", "aw:coder")))).toBeNull();
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("npm test")))).toBeNull(); // the user's own session
  });

  it("can be allowed in the config", () => {
    const dir = makeProject({ guards: { directTestCommands: "allow" } });
    toReadyForTests(dir);
    expect(permissionDecision(hook(dir, "pre-tool-use", bashCall("npm test", "aw:coder")))).toBeNull();
    expect(expectOk(cli(dir, ["tester", "start"])).out).not.toContain("are blocked for aw agents");
  });
});
