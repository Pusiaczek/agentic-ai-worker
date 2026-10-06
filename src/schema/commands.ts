/**
 * Command words of the aw CLI: `aw <command> <action>`. The routers (main.ts, commands/*) and the hook
 * guards use these names, so "Find All References" shows both where a command runs and where it is guarded.
 */
import { z } from "zod";

export const AwCommand = z.enum([
  "sm",
  "tester",
  "reviewer",
  "coder",
  "test",
  "refine",
  "show",
  "schema",
  "backlog",
  "stats",
  "doctor",
  "init",
  "hook",
  "version",
  "help",
]);
export type AwCommand = z.infer<typeof AwCommand>;

/** `aw sm <action>`: the orchestrator's (main session's) commands. */
export const SmAction = z.enum([
  "new",
  "plan",
  "approve",
  "next",
  "note",
  "block",
  "unblock",
  "cancel",
  "reset",
  "docs",
  "accept",
  "reopen",
  "archive",
  "repair",
]);
export type SmAction = z.infer<typeof SmAction>;

/** `aw tester|reviewer|coder <action>`: a task role's own commands. */
export const RoleAction = z.enum(["start", "submit", "fail"]);
export type RoleAction = z.infer<typeof RoleAction>;

/** `aw refine <action>`: splitting a slice into tasks. `submit` is the product owner's, the rest the main session's. */
export const RefineAction = z.enum(["new", "next", "start-agent", "submit", "note", "approve", "cancel", "reset", "show"]);
export type RefineAction = z.infer<typeof RefineAction>;

/** `aw backlog set …` changes an item; `aw backlog` without an action lists the backlog. */
export const BacklogAction = z.enum(["set"]);
export type BacklogAction = z.infer<typeof BacklogAction>;

/** `aw hook <event>`: the hook events wired in plugins/aw/hooks/hooks.json. */
export const HookEvent = z.enum(["pre-tool-use", "post-tool-use", "subagent-start", "subagent-stop"]);
export type HookEvent = z.infer<typeof HookEvent>;
