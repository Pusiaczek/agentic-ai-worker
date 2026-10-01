# agentic-ai-worker

Source of the `aw` Claude Code plugin and its local marketplace. The user (Polish-speaking) installs it in work repositories; see README.md (Polish) for the user-facing overview.

## Layout
- `src/` — the `aw` CLI (TypeScript, zod). Entry `src/cli.ts` → `run()` in `src/main.ts`.
  - `schema/` — single source of truth: statuses + transitions (`status.ts`), agent/orchestrator inputs (`outputs.ts`), task state (`state.ts`), repo config (`config.ts`), examples printed by `aw schema` (`examples.ts`).
  - `core/` — state store (atomic write + lock + sha256 seal), state machine helpers, semantic validation, gates, briefing, `aw sm next`, report rendering.
  - `commands/` — `sm` (orchestrator), role commands (`start`/`submit`/`fail`), info, init, hook entry.
  - `hooks/` — PreToolUse guards, subagent lifecycle, shell parsing.
- `plugins/aw/` — the plugin: `agents/`, `skills/`, `hooks/hooks.json`, `bin/` launchers, `templates/`, and `cli/aw.mjs` (GENERATED bundle — never edit by hand).
  - `templates/code-standards.md` — default code standards the CLI injects into every coder/tester/reviewer briefing (repos add their own in `.claude/aw/code-standards.md`).
- `.claude-plugin/marketplace.json` — local marketplace pointing at `./plugins/aw`.
- `test/` — vitest; drives the CLI in-process via `run()` against temp projects (`test/helpers.ts`).

## Open work
`TODO.md` (Polish) lists planned changes with the reason behind each. Check it before starting work on the plugin, and move items to "Zrobione" when done.

## Commands
- `npm run check` — typecheck + tests + build. Run it after every change to `src/`; the plugin executes the bundle, so an unbuilt change does nothing.
- `npx vitest run test/hooks.test.ts` — one file.
- Validate the plugin: `claude plugin validate ./plugins/aw` and `claude plugin validate .`.

## Conventions
- Schema changes go in `src/schema/*` first; keep agent inputs `.strict()`; IDs (T-, F-, N-, R-, AC-) are assigned by the CLI, never by agents.
- State is append-only: add runs/events/notes, never rewrite history. Every write goes through `mutate()` / `writeState()`.
- Rules that can be checked deterministically belong in the CLI or hooks, not in prompts. Prompts explain; code enforces.
- Hooks must never break the user's session: no config → no output; internal errors fail closed only for aw agents.
- Code is read by a human reviewer, so optimize for reading:
  - descriptive names, no single-letter variables outside one-line lambdas;
  - no nested ternaries;
  - a repeated or non-obvious condition gets a named function with a doc comment (e.g. `directTestCommandsBlocked`, `findTestRunnerCall`);
  - shared types and enums come from `src/schema/*` (`Role`, `DirectTestCommands`, …) instead of ad-hoc string unions or repeated literals.
- Tests: no `any`. Use the typed helpers in `test/helpers.ts` (`HookResponse`, `permissionDecision`, `bashCall`/`editCall`, `runAt`, `runOfRole`, `readJson<T>`).
- Agent and skill prompts (English) reference the CLI contract; when a command or field changes, update `plugins/aw/agents/*.md`, `plugins/aw/skills/*/SKILL.md`, `src/schema/examples.ts` and README.md together.
