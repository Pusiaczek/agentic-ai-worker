/** Everything the CLI touches from its environment, injectable for tests. */
export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  readStdin: () => string;
  out: (text: string) => void;
  err: (text: string) => void;
}
