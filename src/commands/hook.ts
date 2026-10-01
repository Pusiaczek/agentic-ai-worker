/**
 * `aw hook <event>` — entry point for the plugin's hooks (hooks/hooks.json). Reads the hook JSON
 * from stdin, prints the hook response JSON. Never fails the user's session: on an internal error
 * it only fails closed for aw agents' tool calls.
 */
import { tryLoadCtx } from "../core/project";
import { guardUninitialized, type HookInput, preToolUse } from "../hooks/guards";
import { identify } from "../hooks/identity";
import { afterAgentCall, subagentStart, subagentStop } from "../hooks/lifecycle";
import type { Io } from "../io";
import { EXIT } from "../util/errors";

const emit = (io: Io, payload: unknown) => io.out(JSON.stringify(payload));

export function hookCommand(argv: string[], io: Io): number {
  const event = argv[0] ?? "";
  let input: HookInput;
  try {
    input = JSON.parse(io.readStdin() || "{}") as HookInput;
  } catch {
    return EXIT.OK;
  }
  const guardedAgent = event === "pre-tool-use" && identify(input.agent_type).kind === "role";
  const failClosed = (message: string) => {
    if (guardedAgent) {
      emit(io, {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `aw guard error: ${message}` },
      });
    } else io.err(`aw hook ${event}: ${message}`);
    return EXIT.OK;
  };

  try {
    const ctx = tryLoadCtx(input.cwd || io.cwd);
    if (!ctx) {
      // Repository doesn't use aw: only aw's own agents are stopped here.
      const d = event === "pre-tool-use" ? guardUninitialized(input) : null;
      if (d) {
        emit(io, {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.permissionDecision, permissionDecisionReason: d.reason },
        });
      }
      if (event === "subagent-start" && identify(input.agent_type).kind === "role") {
        emit(io, {
          hookSpecificOutput: {
            hookEventName: "SubagentStart",
            additionalContext: "aw: this repository is not set up for aw (no .claude/aw.config.json). Do nothing; reply in one line that aw is not initialized here.",
          },
        });
      }
      return EXIT.OK;
    }
    switch (event) {
      case "pre-tool-use": {
        const d = preToolUse(ctx, input);
        if (d) {
          emit(io, {
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.permissionDecision, permissionDecisionReason: d.reason },
          });
        }
        return EXIT.OK;
      }
      case "post-tool-use": {
        const context = afterAgentCall(ctx, input);
        if (context) emit(io, { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } });
        return EXIT.OK;
      }
      case "subagent-start": {
        const context = subagentStart(ctx, input);
        if (context) emit(io, { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context } });
        return EXIT.OK;
      }
      case "subagent-stop": {
        const d = subagentStop(ctx, input);
        if (d) emit(io, d);
        return EXIT.OK;
      }
      default:
        io.err(`aw hook: unknown event "${event}"`);
        return EXIT.OK;
    }
  } catch (e) {
    return failClosed((e as Error).message);
  }
}
