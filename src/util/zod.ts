import type { z } from "zod";

/** Zod issues as `path: message` lines an agent can act on. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? formatPath(issue.path) : "(root)";
    return `${where}: ${issue.message}`;
  });
}

function formatPath(p: PropertyKey[]): string {
  return p
    .map((seg, i) => (typeof seg === "number" ? `[${seg}]` : i === 0 ? String(seg) : `.${String(seg)}`))
    .join("");
}
