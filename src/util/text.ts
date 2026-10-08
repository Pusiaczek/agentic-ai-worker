/** Comparing texts written by agents, which often copy the same sentence into several outputs. */

/** The text as compared for repeats: case and runs of whitespace don't matter. */
export function repeatKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The texts without repeats (see repeatKey), keeping the first of each, in order. */
export function withoutRepeats(texts: string[]): string[] {
  const seen = new Set<string>();
  return texts.filter((text) => {
    const key = repeatKey(text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
