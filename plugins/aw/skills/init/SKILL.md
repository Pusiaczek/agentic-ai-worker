---
name: init
description: Sets up the aw pipeline in the current repository — detects commands, writes .claude/aw.config.json, role notes and the docs index, and reviews CLAUDE.md. Use when the user wants to start using aw in a repo, or asks to (re)configure it.
argument-hint: "[--language <lang>] [--shared] [--force]"
disable-model-invocation: true
---

# aw init

Onboard this repository for the aw pipeline. The CLI does the mechanical part. You do the part that needs judgment, and you ask the user only what you can't find out.

`aw` is on the Bash tool's PATH. If it isn't found, use `node "${CLAUDE_PLUGIN_ROOT}/cli/aw.mjs"` in the Bash tool.

Arguments: `$ARGUMENTS`

## Steps

0. **Empty directory?** If there is no project yet (no `package.json` or other manifest, no source), set one up first, asking before every side effect:
   - ask about the stack with concrete options (AskUserQuestion), e.g. language and runtime, framework, database and ORM, test runner, linter;
   - ask before `git init`; aw works best with git, because reviewers diff against the task's base commit;
   - scaffold only what the user agreed to, install dependencies, and check that the test command runs;
   - then continue with step 1, so `aw init` detects the real commands and gates.
1. **Scaffold.** Run `aw init $ARGUMENTS` from the repository root. It detects the package manager, scripts and test runner, then writes:
   - `.claude/aw.config.json` and its schema,
   - role-note templates in `.claude/aw/`.

   It also sets the **sharing mode**, which the report states on its `mode:` line:
   - **local** (default, "ghost"): everything aw creates is hidden from git via `.git/info/exclude`. The team never sees it, and `.gitignore` is not touched. Personal instructions go to `CLAUDE.local.md`.
   - **shared** (`--shared`): the config and role notes are meant to be committed, `.tasks/` goes to `.gitignore`, and instruction changes go to `CLAUDE.md`.

   Read its report. Ask the user which language agents should write their summaries in, unless `--language` was given. Set `language` in the config.

2. **Verify commands.** Open `.claude/aw.config.json`. For each entry in `commands`, check it's right for this repo (package.json scripts, CI config, README). Fix wrong ones.
   - `testFiles` must run only the given files (`{files}` placeholder). It's used for the TDD "tests must fail first" check.
   - Gates: `afterTests` (usually `testFiles`, expect fail, warn) and `afterCoding` (lint/typecheck/test, expect pass, reject).
   - If running the test suite is slow or needs services (DB, docker), tell the user and agree on what the gates should run.

3. **Test globs.** Check `tests.globs` against where tests actually live (Glob). The tester can only write files matching them, so include fixture/helper directories.

4. **Documentation index** (`docs` in the config). Skim each listed doc and replace every `TODO` in `when` with one precise line saying when an agent should read or update it (e.g. "read when touching src/auth or login endpoints; update when the login API changes"). Drop irrelevant docs and add important ones outside `docs/` (ADRs, API specs, runbooks).

5. **Role notes** (`.claude/aw/*.md`). Explore the repo (structure, existing tests, helpers, error handling) and fill the sections concisely, with file paths as examples. Ask the user about conventions and "don'ts" you can't infer. Leave a section empty rather than padding it; empty sections are dropped from briefings.
   - `.claude/aw/code-standards.md` holds this repository's code rules. Every agent gets it after the aw default standards (`${CLAUDE_PLUGIN_ROOT}/templates/code-standards.md`), and it wins where they conflict. Show the user the defaults and ask whether the repo has its own rules or exceptions: a style guide, CONTRIBUTING.md, review habits. Don't repeat what the linter or formatter already enforces.

6. **Project instructions.** Compare what the repository already has (CLAUDE.md, AGENTS.md) with the template sections at `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.section.md`. Write only what is missing and useful for agents: commands, architecture, conventions, and a documentation index.
   - **Local mode:** write your additions to `CLAUDE.local.md`. Never edit the team's CLAUDE.md. Claude Code loads CLAUDE.local.md right after CLAUDE.md, and both are always read. **Pitfall:** if the repo uses AGENTS.md and has no CLAUDE.md, a CLAUDE.local.md makes Claude stop reading AGENTS.md, so start CLAUDE.local.md with the line `@AGENTS.md`.
   - **Shared mode:** propose the additions for CLAUDE.md.

   The documentation index must use **plain paths, not `@imports`**, because an import loads the whole file into every session and every agent. Keep the instruction files under ~200 lines. Apply changes after the user agrees.

7. **Permissions (optional).** To avoid prompts for agent commands, offer to add allow rules to `.claude/settings.local.json`: `"Bash(aw *)"` and the configured commands (e.g. `"Bash(npm test *)"`). The human gates (`aw sm approve|accept|repair`) still ask, because the plugin's hook forces the prompt.

8. **Check.** Run `aw doctor` and fix what it reports.

9. **Summarize for the user:**
   - what was configured,
   - what is still TODO,
   - how to start: `/aw:scrum-master <task text or file>`.

Then give the mode-specific reminder:
- **Local mode:** nothing to commit. `git status` should show no aw files. `aw init --shared` switches to shared mode later.
- **Shared mode:** commit `.claude/aw.config.json`, `.claude/aw.config.schema.json`, `.claude/aw/` and the CLAUDE.md changes. `.tasks/` stays ignored.
