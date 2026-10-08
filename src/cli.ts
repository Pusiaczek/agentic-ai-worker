import * as fs from "node:fs";
import { run } from "./main";

/**
 * `aw … | head` closes the pipe after a few lines, and the next write fails with EPIPE (on Linux and macOS).
 * That isn't an error for the user, just as for `cat file | head`, so end quietly instead of crashing
 * on an unhandled 'error' event.
 */
function endQuietlyWhenReaderCloses(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

endQuietlyWhenReaderCloses(process.stdout);
endQuietlyWhenReaderCloses(process.stderr);

const code = run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  readStdin: () => fs.readFileSync(0, "utf8"),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
process.exitCode = code;
