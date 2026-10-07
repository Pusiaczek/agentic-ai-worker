import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Config } from "../src/schema/config";
import { EXAMPLES } from "../src/schema/examples";
import { INPUT_SCHEMAS, type InputSchemaName } from "../src/schema/outputs";
import { Status, TERMINAL, TRANSITIONS } from "../src/schema/status";
import { cli, expectOk, readJson, tmpDir, write } from "./helpers";

describe("schemas", () => {
  it.each(Object.keys(EXAMPLES) as InputSchemaName[])("example for %s is valid", (name) => {
    const r = INPUT_SCHEMAS[name].safeParse(EXAMPLES[name]);
    expect(r.error?.issues ?? []).toEqual([]);
  });

  it("config defaults fill everything from a minimal file", () => {
    const cfg = Config.parse({ version: 1 });
    expect(cfg.paths.tasksDir).toBe(".tasks");
    expect(cfg.agents.coder.resume).toBe("always");
    expect(cfg.agents.reviewer.bashAllow).toContain("git diff");
    expect(cfg.limits.maxCodeIterations).toBe(3);
  });

  it("config rejects gates pointing at unknown commands", () => {
    const r = Config.safeParse({ version: 1, gates: { afterCoding: [{ run: "lint" }] } });
    expect(r.success).toBe(false);
  });

  it("every non-terminal status can move on, and every target exists", () => {
    for (const s of Status.options) {
      if (!TERMINAL.includes(s)) expect(TRANSITIONS[s].length).toBeGreaterThan(0);
      for (const t of TRANSITIONS[s]) expect(Status.options).toContain(t);
    }
  });

  it("aw schema prints JSON Schema and the example for every name", () => {
    for (const name of [...Object.keys(INPUT_SCHEMAS), "config", "state"]) {
      const r = expectOk(cli(process.cwd(), ["schema", name]));
      expect(r.out).toContain('"$schema"');
    }
  });
});

describe("aw init", () => {
  const git = (dir: string, ...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

  it("prints help for --help instead of running, here and for any command", () => {
    const dir = tmpDir();

    expect(expectOk(cli(dir, ["init", "--help"])).out).toContain("aw init [--force] [--language <lang>] [--shared]");
    expect(fs.existsSync(path.join(dir, ".claude", "aw.config.json"))).toBe(false);
    expect(expectOk(cli(dir, ["sm", "-h"])).out).toContain("aw sm <command>");
    expect(expectOk(cli(dir, ["refine", "approve", "--help"])).out).toContain("aw refine <command>");
  });

  it("local mode (default) hides everything from git without touching .gitignore; --shared switches", () => {
    const dir = tmpDir();
    git(dir, "init", "-q");
    write(dir, "package.json", { name: "svc", scripts: { test: "node --test" } });
    write(dir, ".gitignore", "node_modules/\n");
    expect(expectOk(cli(dir, ["init"])).out).toContain('mode: local ("ghost")');

    const exclude = () => fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
    for (const entry of ["/.tasks/", "/.claude/aw.config.json", "/.claude/aw.config.schema.json", "/.claude/aw/", "/CLAUDE.local.md"]) {
      expect(exclude()).toContain(entry);
    }
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n");
    write(dir, "CLAUDE.local.md", "# mine\n");
    expect(git(dir, "status", "--porcelain").stdout).not.toMatch(/\.claude|\.tasks|CLAUDE\.local/);
    expect(cli(dir, ["doctor"]).out).toContain('mode: local ("ghost")');

    expect(expectOk(cli(dir, ["init", "--shared"])).out).toContain("mode: shared");
    expect(exclude()).not.toContain("aw local mode");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain("/.tasks/");
    expect(git(dir, "status", "--porcelain").stdout).toContain(".claude/");
    expect(cli(dir, ["doctor"]).out).toContain("mode: shared");

    expectOk(cli(dir, ["init"]));
    expect(exclude().match(/aw local mode/g)).toHaveLength(1);
  });

  it("detects commands and scaffolds the repository", () => {
    const dir = tmpDir();
    git(dir, "init", "-q");
    write(dir, "package.json", {
      name: "svc",
      scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit" },
      devDependencies: { vitest: "^3" },
    });
    write(dir, "pnpm-lock.yaml", "");
    write(dir, "docs/api.md", "# API\n");
    write(dir, ".gitignore", "node_modules/");
    const r = expectOk(cli(dir, ["init", "--language", "pl"]));
    expect(r.out).toContain("wrote .claude/aw.config.json");

    const cfg = Config.parse(readJson(dir, ".claude/aw.config.json")); // also proves the written config is valid
    expect(cfg.language).toBe("pl");
    expect(cfg.commands).toEqual({
      test: "pnpm test",
      lint: "pnpm run lint",
      typecheck: "pnpm run typecheck",
      testFiles: "npx vitest run {files}",
    });
    expect(cfg.gates.afterCoding.map((gate) => gate.run)).toEqual(["lint", "typecheck", "test"]);
    expect(cfg.docs.map((doc) => doc.path)).toEqual(["docs/api.md"]);
    for (const noteFile of ["coder", "tester", "reviewer", "scrum-master", "code-standards"]) {
      expect(fs.existsSync(path.join(dir, ".claude", "aw", `${noteFile}.md`))).toBe(true);
    }

    const doctor = cli(dir, ["doctor"]);
    expect(doctor.out).toContain("config valid");
    expect(doctor.out).toContain('"when" is still TODO');

    // Re-running keeps the existing config.
    expect(expectOk(cli(dir, ["init"])).out).toContain("config exists");
  });
});
