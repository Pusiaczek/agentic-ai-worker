import type { z } from "zod";

/** Zod issues as `path: message` lines an agent can act on. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? formatPath(issue.path) : "(root)";
    return `${where}: ${issue.message}`;
  });
}

/** A zod issue path as a property path: ["items", 0, "title"] → items[0].title. */
function formatPath(segments: PropertyKey[]): string {
  return segments.map(formatPathSegment).join("");
}

/** One path segment: an array index as `[0]`, a property as `.name` (no dot before the first one). */
function formatPathSegment(segment: PropertyKey, index: number): string {
  if (typeof segment === "number") return `[${segment}]`;
  return index === 0 ? String(segment) : `.${String(segment)}`;
}
