import { hookCommand } from "./commands/hook";
import { backlogCommand, doctorCommand, schemaCommand, showCommand, statsCommand } from "./commands/info";
import { initCommand } from "./commands/init";
import { refineCommand } from "./commands/refine";
import { roleCommand } from "./commands/role";
import { smCommand } from "./commands/sm";
import { testCommand } from "./commands/test";
import type { Io } from "./io";
import { Role } from "./schema/status";
import { AwError, EXIT } from "./util/errors";

export const VERSION = "0.2.0";

const HELP = `aw ${VERSION} — task pipeline for Claude Code (scrum-master · tester · reviewer · coder)

Orchestrator (main session):
  aw sm next                      what to do now (start here)
  aw sm new | plan | approve | note | block | unblock | cancel | reset | docs | accept | reopen | archive | repair
Agents (each only its own):
  aw tester|reviewer|coder start  begin a run — refuses unless the status matches
  aw tester|reviewer|coder submit validate the output file, run gates, move on
  aw tester|reviewer|coder fail --reason "<why>"
Tests:
  aw test [<file>...] [-t "<name>"]  run this task's test files (or the given ones), narrowly, compact output
Splitting a larger feature into tasks (before the pipeline):
  aw refine new | next | start-agent | note | approve | cancel | reset | show
  aw refine submit                (aw:product-owner only) check and record its proposal
Info:
  aw show [--json] [--task <archived-id>]
  aw schema <plan|tester|reviewer|coder|docs|retro|config|state>
  aw backlog [--all] [--kind <k>] | aw backlog set <B-id> <status> [--note "<n>"]
  aw stats | aw doctor
Setup:
  aw init [--force] [--language <lang>]`;

export function run(argv: string[], io: Io): number {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "sm": return smCommand(rest, io);
      case "tester":
      case "reviewer":
      case "coder": return roleCommand(Role.parse(cmd), rest, io);
      case "test": return testCommand(rest, io);
      case "refine": return refineCommand(rest, io);
      case "show": return showCommand(rest, io);
      case "schema": return schemaCommand(rest, io);
      case "backlog": return backlogCommand(rest, io);
      case "stats": return statsCommand(rest, io);
      case "doctor": return doctorCommand(rest, io);
      case "init": return initCommand(rest, io);
      case "hook": return hookCommand(rest, io);
      case "--version":
      case "version":
        io.out(VERSION);
        return EXIT.OK;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return EXIT.OK;
      default:
        throw new AwError(`Unknown command: ${cmd}`, EXIT.USAGE, "Run `aw help`.");
    }
  } catch (e) {
    if (e instanceof AwError) {
      io.err(`aw: ${e.message}`);
      if (e.hint) io.err(e.hint);
      return e.exitCode;
    }
    io.err(`aw: internal error: ${(e as Error).stack ?? String(e)}`);
    return EXIT.ERROR;
  }
}
