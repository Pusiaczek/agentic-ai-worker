---
name: refine
description: Splits a larger feature, epic or vertical slice into small, independently deliverable tasks with the aw:product-owner agent, before they go through the aw pipeline. Use when the user asks to split, refine or break down a feature, epic or slice into tasks ("rozbij na zadania", "podziel na taski"), or to continue a refinement.
argument-hint: "[slice text | path to file | nothing = continue a refinement]"
---

# aw refine

You run a **refinement**: the aw:product-owner agent splits a larger feature (a vertical slice) into small tasks, and the user approves the split. Each approved task becomes a markdown file. The user later takes these files through `/aw:scrum-master <file>`, one at a time.

A refinement doesn't touch the task pipeline, so you can run one while a task is active.

**You don't split the slice yourself, and you don't edit the proposal.** The user's remarks go to the next revision as notes.

The refinement state lives in `.tasks/refinements/<id>/refinement.json`, and **only the `aw` CLI writes it**. `aw refine next` is the source of truth for what to do next. Don't act on what the agent *says* it did.

`aw` is on the Bash tool's PATH. If it isn't found, use `node "${CLAUDE_PLUGIN_ROOT}/cli/aw.mjs"` instead, in the Bash tool.

Arguments: `$ARGUMENTS`

## The loop

1. Run `aw refine next`. Once you know which refinement you're working on, run `aw refine next <id>`.
2. Do exactly what its `NEXT:` block says (details per kind below).
3. Repeat until the split is approved or cancelled, or until you need the user.

Whenever the status changes, tell the user where things stand in one short line, e.g. "The product owner proposed 5 tasks — here they are." Speak the user's language.

## NEXT kinds

### intake: no refinement waits for a step
- Get the slice description. It comes from the arguments (text or a file path), or you ask the user for it.
- If `.claude/aw/product-owner.md` exists, read it: it holds this repo's notes on where slices come from.
- **Jira:** if the user gives a Jira key and a Jira/Atlassian MCP tool is available, you may fetch the epic and its child issues. Put them into the description verbatim, under one heading per source. Without such a tool, ask for the text.
- Run `aw refine new --title "<short title>" [--id <id>] [--input <file>]`.
  - With a file, pass `--input <file>`.
  - With text from the conversation, leave out `--input`. The next step writes the text.

### choose
Several refinements wait for a step. Ask the user which one (AskUserQuestion), then run `aw refine next <id>`.

### write-input
Write the slice description into the printed `input.md` with the Write tool, **verbatim**, as the user or the ticket gave it. Never summarize it: it's the record of what was asked. Then run `aw refine next <id>`.

### spawn-po
1. Run `aw refine start-agent <id>`. It starts the product owner's run and prints `AGENT:` and `MESSAGE:`.
2. Use the Agent tool with:
   - `subagent_type` exactly as in `AGENT:` (`aw:product-owner`);
   - the `MESSAGE:` text as the prompt;
   - `run_in_background: false`.
3. When the agent returns, run `aw refine next <id>`. The agent's reply is one line and may be wrong; the state is authoritative.

Every revision gets a fresh agent. Its briefing carries the previous proposal and the user's notes.

### recover-agent
The agent returned without an accepted proposal.
1. Run `aw refine reset <id>`.
2. Spawn a fresh agent as in spawn-po.

If it fails twice in a row, tell the user what went wrong (the agent's reply, `aw refine show <id>`) and ask how to proceed.

### user-review
Read the printed `proposal.md` and show the user, compactly:
- the items table: item, title, depends on, mode, number of criteria, preparation;
- the open questions, the out-of-scope parts, and any requirement the coverage misses;
- your own short opinion if something looks off, such as a task that's too big, a layer task or a missing error case. Offer it as a suggestion for the user, not as an edit.

Ask with AskUserQuestion: "Approve" / "Changes" / "Cancel". The remarks come as free text. **Wait for an explicit choice in this conversation.**
- **Approve:** run `aw refine approve <id>`. The user confirms this command in a permission prompt, so the approval is recorded as theirs.
- **Changes:**
  1. Split the feedback into separate remarks.
  2. Queue **one note per remark**: `aw refine note <id> --text "<remark, in the user's words>"`. The user's answers to open questions are notes too.
  3. Run `aw refine next <id>`. It leads to a new product-owner run.
- **Cancel:** run `aw refine cancel <id> --reason "<why>"`.

### done
List the task files in delivery order. Tell the user how to start: `/aw:scrum-master <path to the first file>`, then the next file once that task is archived.

The files are plain markdown, so the user may edit them before starting.

### cancelled
Nothing to do. Tell the user.

## Rules
- Never write `refinement.json`.
- Never run `aw refine submit` yourself: it belongs to the product owner.
- Never run `aw refine approve` without the user's explicit choice in this conversation.
- Don't split the slice yourself, and don't edit `proposal.json`. A wrong proposal is a note for the next revision.
- At most one product owner works at a time. Several refinements may wait side by side; `aw refine show` lists them.
- Write files with the Write tool, not with shell heredocs.
- Git history is the user's: don't commit anything.
