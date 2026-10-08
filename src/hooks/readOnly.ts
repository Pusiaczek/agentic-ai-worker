/**
 * Read-only shell commands, for the agents that may only look: the reviewer and the product owner.
 * A simple command (one segment from splitSegments) is read-only when it has no output redirection,
 * no nested command and no option that makes the program write files or run other programs.
 * Which programs an agent may start at all is decided elsewhere (bashAllow, the product owner's list).
 */

/** Collapses runs of whitespace to single spaces, so patterns can use plain spaces. */
export const withSingleSpaces = (segment: string) => segment.replace(/\s+/g, " ").trim();

/** Per program (or program and subcommand): options that write files or run other programs. */
const WRITING_OR_RUNNING_OPTIONS = new Map<string, RegExp>([
  ["find", /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/],
  // Native Claude Code builds run ugrep as `grep`: --filter, --pre, --pager and --view run programs, --save-config writes a file.
  ["grep", /^--(filter|pre|pager|view|save-config)(=|$)/],
  ["rg", /^--(pre|hostname-bin)(=|$)/],
  ["tree", /^-o$/],
  ["git", /^--(output|upload-pack)(=|$)/],
  ["git ls-remote", /^-u$/],
]);

/** Options that write files in any program that has them: linters and formatters fixing code in place. */
const WRITING_OPTION_IN_ANY_PROGRAM = /^--(fix|write)(=|$)/;

/** Redirections that write nothing: errors merged into the output, or thrown away. */
const HARMLESS_REDIRECTS = / 2>&1| 2>\/dev\/null/g;

/**
 * True when the shell would run a nested command: `$(…)`, backticks, `<(…)`, `>(…)`.
 * Single quotes make them plain text; double quotes don't: `grep "$(rm x)" a` still runs rm.
 */
export function runsNestedCommand(segment: string): boolean {
  const withoutSingleQuoted = segment.replace(/'[^']*'/g, "''");
  return /`|\$\(|<\(|>\(/.test(withoutSingleQuoted);
}

/** True when the command writes its output to a file: `> file`, `>> file`, `&> file`. A `>` inside quotes is text. */
export function redirectsOutput(segment: string): boolean {
  const withoutQuoted = segment.replace(/'[^']*'|"[^"]*"/g, '""').replace(HARMLESS_REDIRECTS, "");
  return withoutQuoted.includes(">");
}

/**
 * True when an option makes the program write or run something:
 * `find -delete`, `git diff --output=x`, `git ls-remote -u ./x.sh origin`, `npm run lint -- --fix`.
 */
export function usesWritingOption(segment: string): boolean {
  const [programPath = "", ...args] = withSingleSpaces(segment).split(" ");
  const program = programPath.split(/[\\/]/).pop() ?? "";
  const writingOptions = [
    WRITING_OPTION_IN_ANY_PROGRAM,
    WRITING_OR_RUNNING_OPTIONS.get(program),
    WRITING_OR_RUNNING_OPTIONS.get(`${program} ${args[0] ?? ""}`),
  ];
  return writingOptions.some((option) => option !== undefined && args.some((arg) => option.test(arg)));
}

/** One simple command that only reads. E.g. `grep -rn "a > b" src` is read-only; `find . -delete` is not. */
export function isReadOnlyCommand(segment: string): boolean {
  return !runsNestedCommand(segment) && !redirectsOutput(segment) && !usesWritingOption(segment);
}
