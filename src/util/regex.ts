/** Building a long regular expression from small, named parts, so each part can be read on its own. */

/** A part wrapped in a non-capturing group, so an `a|b` inside it can't swallow its neighbours. */
const grouped = (part: RegExp) => `(?:${part.source})`;

/** Matches any one of the parts: anyOf(/a/, /bc/) matches "a" or "bc". */
export function anyOf(...parts: RegExp[]): RegExp {
  return new RegExp(parts.map(grouped).join("|"));
}

/** The parts one after another: inOrder(/node /, /\S+/) matches "node x.mjs". */
export function inOrder(...parts: RegExp[]): RegExp {
  return new RegExp(parts.map(grouped).join(""));
}

/** Literal words separated by single spaces: words("refine", "submit") matches "refine submit". */
export function words(...parts: string[]): RegExp {
  return new RegExp(parts.map(escapeRegExp).join(" "));
}

/** Text with regex special characters escaped, so it matches itself: "aw.mjs" → "aw\.mjs". */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The parts one after another, covering the whole text and nothing more. */
export function wholeText(...parts: RegExp[]): RegExp {
  return new RegExp(`^${inOrder(...parts).source}$`);
}
