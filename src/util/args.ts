import { AwError, EXIT } from "./errors";

export interface Args {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** `--key value`, `--key=value`, and boolean `--key` (for names listed in `booleans`). */
export function parseArgs(argv: string[], booleans: readonly string[] = []): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (booleans.includes(name) || next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { positionals, flags };
}

export function str(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function requireStr(args: Args, name: string, usage: string): string {
  const v = str(args, name);
  if (!v || !v.trim()) throw new AwError(`Missing --${name}.`, EXIT.USAGE, `Usage: ${usage}`);
  return v;
}

export function bool(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}
