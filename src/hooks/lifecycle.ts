/**
 * Subagent lifecycle hooks: record which agent did which run (for resuming and for traces),
 * keep an agent from stopping before it submits, and keep its final reply short.
 */
import { addEvent, runsOf } from "../core/machine";
import { recoverMessage } from "../core/next";
import type { Ctx } from "../core/project";
import { findActiveTask, mutate, readState } from "../core/store";
import { nowIso } from "../util/fsx";
import type { HookInput } from "./guards";
import { identify } from "./identity";

export function subagentStart(ctx: Ctx, input: HookInput): string | null {
  const who = identify(input.agent_type);
  if (who.kind !== "role") return null;
  const ref = findActiveTask(ctx);
  if (!ref) return `aw: there is no active task — \`aw ${who.role} start\` will fail. Report that in one line and stop.`;
  if (input.agent_id) {
    mutate(ref, (s) => {
      s.lastSpawn[who.role] = { agentId: input.agent_id!, at: nowIso() };
      addEvent(s, "hook", "agent_spawned", `aw:${who.role} ${input.agent_id}`);
    });
  }
  return `aw: you are aw:${who.role} for task ${ref.id}. Your first action must be \`aw ${who.role} start\`.`;
}

export function subagentStop(ctx: Ctx, input: HookInput): { decision: "block"; reason: string } | null {
  const who = identify(input.agent_type);
  if (who.kind !== "role") return null;
  const ref = findActiveTask(ctx);
  if (!ref) return null;
  const agentId = input.agent_id;
  const limits = ctx.config.limits;

  return mutate(ref, (s) => {
    const runs = runsOf(s, who.role);
    const run = (agentId && [...runs].reverse().find((r) => r.agentId === agentId)) || runs.find((r) => r.state === "active");
    if (!run || (run.agentId && agentId && run.agentId !== agentId)) return null;
    if (agentId && !run.agentId) run.agentId = agentId;
    if (input.agent_transcript_path) run.transcriptPath = input.agent_transcript_path;

    if (run.state === "active") {
      if (run.stopBlocks < limits.stopBlocks) {
        run.stopBlocks += 1;
        addEvent(s, "hook", "stop_blocked", "agent tried to stop before submitting", run.id);
        return { decision: "block" as const, reason: recoverMessage(run) };
      }
      run.stoppedWithoutSubmit = true;
      addEvent(s, "hook", "agent_stopped_without_submit", undefined, run.id);
      return null;
    }
    const message = input.last_assistant_message ?? "";
    if (message.length > limits.finalMessageMaxChars && run.finalMessageBlocks < 1 && !input.stop_hook_active) {
      run.finalMessageBlocks += 1;
      addEvent(s, "hook", "final_message_too_long", `${message.length} chars`, run.id);
      return {
        decision: "block" as const,
        reason: `Your final reply is ${message.length} characters; the limit is ${limits.finalMessageMaxChars}. Reply again with exactly ONE line, e.g. "${run.role} ${run.id}: ${run.state} — <≤15 words>". Everything else is already in the state file.`,
      };
    }
    addEvent(s, "hook", "agent_stopped", undefined, run.id);
    return null;
  });
}

/** After the orchestrator's Agent / SendMessage call returns: point it at the state, not at the agent's words. */
export function afterAgentCall(ctx: Ctx, input: HookInput): string | null {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const ref = findActiveTask(ctx);
  if (!ref) return null;
  const s = readState(ref);
  let relevant = false;
  if (tool === "Agent" || tool === "Task") relevant = identify(String(ti.subagent_type ?? "")).kind === "role";
  if (tool === "SendMessage") relevant = s.runs.some((r) => r.agentId && r.agentId === ti.to);
  if (!relevant) return null;
  return `aw: task ${s.id} is now ${s.status}. Don't rely on the agent's reply — run \`aw sm next\`.`;
}
