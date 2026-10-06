/** Just enough shell parsing to police commands: split into simple commands, find aw invocations. */

/** Split on unquoted ; && || | & and newlines. Keeps redirections like 2>&1 intact. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  const push = () => {
    const s = stripPrefixes(cur.trim());
    if (s) segments.push(s);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
    } else if (c === "&" && (cur.endsWith(">") || command[i + 1] === ">")) {
      cur += c; // 2>&1, &>file
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      push();
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
    } else cur += c;
  }
  push();
  return segments;
}

/** Drop leading `VAR=value`, `(`, `{`, `!` so the command word comes first. */
function stripPrefixes(segment: string): string {
  let s = segment.replace(/^[({!\s]+/, "");
  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

export function startsWithCommand(segment: string, prefix: string): boolean {
  if (prefix === "*") return true;
  const seg = segment.replace(/\s+/g, " ");
  const p = prefix.trim().replace(/\s+/g, " ");
  return seg === p || seg.startsWith(`${p} `);
}

export interface AwInvocation {
  sub: string;
  action?: string;
}

/**
 * Finds `aw <sub> [<action>]` anywhere in a command, including `node .../aw.mjs <sub>`,
 * `aw.cmd`, and nested forms like `bash -c "aw sm approve"`.
 */
export function findAwInvocations(command: string): AwInvocation[] {
  const re = /(?:^|[\s;&|("'`])(?:[^\s;&|("'`]*[\\/])?aw(?:\.cmd|\.mjs)?["']?\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g;
  const found: AwInvocation[] = [];
  for (const m of command.matchAll(re)) found.push({ sub: m[1]!, ...(m[2] ? { action: m[2] } : {}) });
  return found;
}

const STATE_WRITE = /(>|\btee\b|\bmv\b|\bcp\b|\brm\b|\bsed\s+-i|\bperl\s+-i|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|writeFile|\bdel\b|\bcopy\b|\bmove\b)/i;

/**
 * True when a shell command may write a file only the CLI writes: state.json, refinement.json or their seals.
 * A heuristic: the file is mentioned and the command contains any write operation.
 */
export function writesStateFile(command: string): boolean {
  return /(state|refinement)\.(json|sha256)\b/.test(command) && STATE_WRITE.test(command);
}
