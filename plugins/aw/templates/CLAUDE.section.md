<!-- aw: suggested project-instruction sections. Every session and every aw agent loads CLAUDE.md and
     CLAUDE.local.md (the local file is appended after CLAUDE.md), so keep them under ~200 lines and factual.
     Local mode: put only what the team's CLAUDE.md lacks into CLAUDE.local.md. Shared mode: merge into CLAUDE.md.
     Don't duplicate what is already there. -->

## Project overview
<!-- 2-4 sentences: what this service/app does, main tech (Node version, framework, DB). -->

## Commands
<!-- install, build, test (all / one file), lint, typecheck, run locally. Exact commands. -->

## Architecture
<!-- Top-level directories and their responsibilities; how a request flows; module boundaries. -->

## Conventions
<!-- Error handling, logging, naming, testing conventions — with example file paths. -->

## Documentation index
<!-- One line per doc: path — what it covers — when to read it.
     Use plain paths, NOT @imports: an @import loads the whole file into every session;
     a plain path is read only when the agent decides it needs it.
     Example:
     - docs/auth.md — login flow, tokens, error format. Read when touching src/auth or login endpoints. -->
