/** Files shipped inside the plugin (templates, default code standards) — found next to the bundle or, from source, in the repo. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AwError } from "../util/errors";
import { readTextIfExists } from "../util/fsx";

export function templatesDir(env: Record<string, string | undefined> = process.env): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.AW_TEMPLATES_DIR,
    path.resolve(here, "../templates"), // bundled: plugins/aw/cli/aw.mjs
    path.resolve(here, "../../plugins/aw/templates"), // source: src/core/pluginFiles.ts
  ].filter((candidate): candidate is string => !!candidate);
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "role-notes")));
  if (!found) throw new AwError(`aw templates not found (looked in: ${candidates.join(", ")}).`);
  return found;
}

/** A template's text, or null when the plugin files can't be found (briefings must still work). */
export function readPluginTemplate(name: string): string | null {
  try {
    return readTextIfExists(path.join(templatesDir(), name));
  } catch {
    return null;
  }
}
