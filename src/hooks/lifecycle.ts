/**
 * Subagent lifecycle hooks: record which agent did which run (for resuming and for traces),
 * keep an agent from stopping before it submits, and keep its final reply short.
 */
import { addEvent, runsOf } from "../core/machine";
import { recoverMessage } from "../core/next";
import { type Ctx, rel } from "../core/project";
import { activeRefinementRun, addRefinementEvent } from "../core/refinementMachine";
import { findWorkingRefinement, mutateRefinement, refinementPaths } from "../core/refinementStore";
import { findActiveTask, mutate, readState } from "../core/store";
import { RefinementActor, RefinementEventName } from "../schema/refinement";
import { RunState, TaskEventName } from "../schema/state";
import { Actor } from "../schema/status";
import { nowIso } from "../util/fsx";
import type { HookInput } from "./guards";
import { identify, isProductOwner, isTaskRole } from "./identity";

/** The product owner learns which refinement it works on, and its agent id is recorded on the run. */
function productOwnerStart(ctx: Ctx, input: HookInput): string {
  const working = findWorkingRefinement(ctx);
  if (!working) {
    return "aw: no refinement has an active product-owner run, so there is nothing to refine. Reply in one line that the orchestrator must run `aw refine start-agent <id>` first, and stop.";
  }
  const run = mutateRefinement(working.ref, (s) => {
    const active = activeRefinementRun(s);
    if (active && input.agent_id && !active.agentId) {
      active.agentId = input.agent_id;
      addRefinementEvent(s, RefinementActor.enum.hook, RefinementEventName.enum.agent_spawned, input.agent_id);
    }
    return active;
  });
  const paths = refinementPaths(working.ref);
  return `aw: you are aw:product-owner for refinement ${working.ref.id} (run ${run?.id ?? "?"}). Read ${rel(ctx, paths.briefing)} first. Write only ${rel(ctx, paths.proposal)}, then run \`aw refine submit\`.`;
}

/** Keeps the product owner from stopping before an accepted `aw refine submit`, up to limits.stopBlocks times. */
function productOwnerStop(ctx: Ctx, input: HookInput): { decision: "block"; reason: string } | null {
  const working = findWorkingRefinement(ctx);
  if (!working) return null;
  const proposal = rel(ctx, refinementPaths(working.ref).proposal);
  return mutateRefinement(working.ref, (s) => {
    const run = activeRefinementRun(s);
    if (!run || (run.agentId && input.agent_id && run.agentId !== input.agent_id)) return null;
    if (input.agent_transcript_path) run.transcriptPath = input.agent_transcript_path;
    if (run.stopBlocks < ctx.config.limits.stopBlocks) {
      run.stopBlocks += 1;
      addRefinementEvent(s, RefinementActor.enum.hook, RefinementEventName.enum.stop_blocked, run.id);
      return {
        decision: "block" as const,
        reason: `You haven't submitted a proposal yet. Write it to ${proposal} and run \`aw refine submit\`; if it reports errors, fix the file and run it again. Then reply in one line.`,
      };
    }
    run.stoppedWithoutSubmit = true;
    addRefinementEvent(s, RefinementActor.enum.hook, RefinementEventName.enum.agent_stopped_without_submit, run.id);
    return null;
  });
}

export function subagentStart(ctx: Ctx, input: HookInput): string | null {
  const who = identify(input.agent_type);
  if (isProductOwner(who)) return productOwnerStart(ctx, input);
  if (!isTaskRole(who)) return null;
  const ref = findActiveTask(ctx);
  if (!ref) return `aw: there is no active task — \`aw ${who.role} start\` will fail. Report that in one line and stop.`;
  if (input.agent_id) {
    mutate(ref, (s) => {
      s.lastSpawn[who.role] = { agentId: input.agent_id!, at: nowIso() };
      addEvent(s, Actor.enum.hook, TaskEventName.enum.agent_spawned, `aw:${who.role} ${input.agent_id}`);
    });
  }
  return `aw: you are aw:${who.role} for task ${ref.id}. Your first action must be \`aw ${who.role} start\`.`;
}

export function subagentStop(ctx: Ctx, input: HookInput): { decision: "block"; reason: string } | null {
  const who = identify(input.agent_type);
  if (isProductOwner(who)) return productOwnerStop(ctx, input);
  if (!isTaskRole(who)) return null;
  const ref = findActiveTask(ctx);
  if (!ref) return null;
  const agentId = input.agent_id;
  const limits = ctx.config.limits;

  return mutate(ref, (s) => {
    const runs = runsOf(s, who.role);
    const run = (agentId && [...runs].reverse().find((r) => r.agentId === agentId)) || runs.find((r) => r.state === RunState.enum.active);
    if (!run || (run.agentId && agentId && run.agentId !== agentId)) return null;
    if (agentId && !run.agentId) run.agentId = agentId;
    if (input.agent_transcript_path) run.transcriptPath = input.agent_transcript_path;

    if (run.state === RunState.enum.active) {
      if (run.stopBlocks < limits.stopBlocks) {
        run.stopBlocks += 1;
        addEvent(s, Actor.enum.hook, TaskEventName.enum.stop_blocked, "agent tried to stop before submitting", run.id);
        return { decision: "block" as const, reason: recoverMessage(run) };
      }
      run.stoppedWithoutSubmit = true;
      addEvent(s, Actor.enum.hook, TaskEventName.enum.agent_stopped_without_submit, undefined, run.id);
      return null;
    }
    const message = input.last_assistant_message ?? "";
    if (message.length > limits.finalMessageMaxChars && run.finalMessageBlocks < 1 && !input.stop_hook_active) {
      run.finalMessageBlocks += 1;
      addEvent(s, Actor.enum.hook, TaskEventName.enum.final_message_too_long, `${message.length} chars`, run.id);
      return {
        decision: "block" as const,
        reason: `Your final reply is ${message.length} characters; the limit is ${limits.finalMessageMaxChars}. Reply again with exactly ONE line, e.g. "${run.role} ${run.id}: ${run.state} — <≤15 words>". Everything else is already in the state file.`,
      };
    }
    addEvent(s, Actor.enum.hook, TaskEventName.enum.agent_stopped, undefined, run.id);
    return null;
  });
}

/** Claude Code's tool that starts a subagent: "Agent" (older versions call it "Task"). */
function spawnsSubagent(tool: string): boolean {
  return tool === "Agent" || tool === "Task";
}

/** After the orchestrator's Agent / SendMessage call returns: point it at the state, not at the agent's words. */
export function afterAgentCall(ctx: Ctx, input: HookInput): string | null {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const calledAgent = identify(String(ti.subagent_type ?? ""));
  if (spawnsSubagent(tool) && isProductOwner(calledAgent)) {
    return "aw: run `aw refine next` — don't rely on the product owner's reply; the refinement state is the source of truth.";
  }
  const ref = findActiveTask(ctx);
  if (!ref) return null;
  const s = readState(ref);
  let relevant = false;
  if (spawnsSubagent(tool)) relevant = isTaskRole(calledAgent);
  if (tool === "SendMessage") relevant = s.runs.some((r) => r.agentId && r.agentId === ti.to);
  if (!relevant) return null;
  return `aw: task ${s.id} is now ${s.status}. Don't rely on the agent's reply — run \`aw sm next\`.`;
}
