import * as fs from "node:fs";
import { run } from "./main";

const code = run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  readStdin: () => fs.readFileSync(0, "utf8"),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
process.exitCode = code;
