import { hookCommand } from "./commands/hook";
import { backlogCommand, doctorCommand, schemaCommand, showCommand, statsCommand } from "./commands/info";
import { initCommand } from "./commands/init";
import { refineCommand, USAGE as REFINE_USAGE } from "./commands/refine";
import { roleCommand } from "./commands/role";
import { smCommand, USAGE as SM_USAGE } from "./commands/sm";
import { testCommand, USAGE as TEST_USAGE } from "./commands/test";
import type { Io } from "./io";
import { AwCommand } from "./schema/commands";
import { AwError, EXIT } from "./util/errors";

export const VERSION = "0.2.2";

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
  aw init [--force] [--language <lang>] [--shared]

Any command with --help (or -h) prints help instead of running.`;

/** Flags that work like commands: `aw --version`, `aw --help`, `aw -h`. */
const COMMAND_FLAGS = new Map<string, AwCommand>([
  ["--version", AwCommand.enum.version],
  ["--help", AwCommand.enum.help],
  ["-h", AwCommand.enum.help],
]);

/** Commands with their own usage text; the others print the general help. */
const COMMAND_USAGE = new Map<AwCommand, string>([
  [AwCommand.enum.sm, SM_USAGE],
  [AwCommand.enum.refine, REFINE_USAGE],
  [AwCommand.enum.test, TEST_USAGE],
]);

/**
 * `aw <command> … --help` (or -h): print help instead of running the command.
 * Without this, `aw init --help` would write the config.
 */
function asksForHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** The command word of `aw <word> …`; `aw` alone shows the help. */
function commandWord(word: string | undefined): string {
  if (word === undefined) return AwCommand.enum.help;
  return COMMAND_FLAGS.get(word) ?? word;
}

export function run(argv: string[], io: Io): number {
  const [word, ...rest] = argv;
  try {
    const command = AwCommand.safeParse(commandWord(word));
    if (!command.success) throw new AwError(`Unknown command: ${word}`, EXIT.USAGE, "Run `aw help`.");
    if (asksForHelp(rest)) {
      io.out(COMMAND_USAGE.get(command.data) ?? HELP);
      return EXIT.OK;
    }
    switch (command.data) {
      case AwCommand.enum.sm: return smCommand(rest, io);
      case AwCommand.enum.tester:
      case AwCommand.enum.reviewer:
      case AwCommand.enum.coder: return roleCommand(command.data, rest, io);
      case AwCommand.enum.test: return testCommand(rest, io);
      case AwCommand.enum.refine: return refineCommand(rest, io);
      case AwCommand.enum.show: return showCommand(rest, io);
      case AwCommand.enum.schema: return schemaCommand(rest, io);
      case AwCommand.enum.backlog: return backlogCommand(rest, io);
      case AwCommand.enum.stats: return statsCommand(rest, io);
      case AwCommand.enum.doctor: return doctorCommand(rest, io);
      case AwCommand.enum.init: return initCommand(rest, io);
      case AwCommand.enum.hook: return hookCommand(rest, io);
      case AwCommand.enum.version:
        io.out(VERSION);
        return EXIT.OK;
      case AwCommand.enum.help:
        io.out(HELP);
        return EXIT.OK;
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
