import picomatch from "picomatch";

export type PathMatcher = (posixPath: string) => boolean;

export function globMatcher(globs: string[]): PathMatcher {
  if (globs.length === 0) return () => false;
  const isMatch = picomatch(globs, { dot: true });
  return (p) => isMatch(p);
}
