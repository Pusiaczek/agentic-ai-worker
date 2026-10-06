/**
 * `aw sm next`: the single place that decides what the orchestrator does next.
 * The scrum-master skill follows this output instead of reasoning about the state machine itself.
 */
import { ResumePolicy } from "../schema/config";
import { NoteSource, type Run, type TaskState } from "../schema/state";
import { type Role, roleForStatus, Status } from "../schema/status";
import { activeRun, latestRun, pendingNotes } from "./machine";
import type { Ctx } from "./project";

export interface NextAction {
  kind:
    | "intake"
    | "plan"
    | "user-approval"
    | "spawn-agent"
    | "recover-agent"
    | "docs-check"
    | "user-acceptance"
    | "resolve-block"
    | "archive";
  lines: string[];
}

const agentName = (role: Role) => `aw:${role}`;

export function startMessage(s: TaskState, role: Role): string {
  return `Task ${s.id}. You are the ${role} in the aw pipeline. Your first action: run \`aw ${role} start\` and follow the briefing it prints. If it fails, stop and reply with the error in one line.`;
}

export function resumeMessage(s: TaskState, role: Role): string {
  return `Task ${s.id}: a new ${role} iteration is ready. Run \`aw ${role} start\` and follow the NEW briefing (it lists what you must address).`;
}

export function recoverMessage(run: Run): string {
  return `You stopped without finishing the aw protocol for run ${run.id}. Run \`aw ${run.role} submit\` (fix any errors it reports) or \`aw ${run.role} fail --reason "<why>"\`. Then reply with one line.`;
}

/**
 * Whether the role's next iteration continues the previous agent (agents.<role>.resume):
 * always, never, or only when a dispute about the tests was resolved for this role ("on-dispute").
 */
function shouldResume(policy: ResumePolicy, s: TaskState, role: Role): boolean {
  if (policy === ResumePolicy.enum.always) return true;
  if (policy === ResumePolicy.enum["on-dispute"]) return pendingNotes(s, role).some((note) => note.source === NoteSource.enum.dispute);
  return false;
}

function spawn(ctx: Ctx, s: TaskState, role: Role): NextAction {
  const agentId = latestRun(s, role)?.agentId ?? s.lastSpawn[role]?.agentId;
  const policy = ctx.config.agents[role].resume;
  const resume = !!agentId && shouldResume(policy, s, role);
  return {
    kind: "spawn-agent",
    lines: [
      `AGENT: ${agentName(role)}`,
      resume
        ? `HOW: resume agent ${agentId} with SendMessage (policy "${policy}"). If resuming fails, spawn a fresh ${agentName(role)} with the fresh message below.`
        : `HOW: spawn a fresh ${agentName(role)} (Agent tool, run_in_background: false).`,
      `MESSAGE: ${resume ? resumeMessage(s, role) : startMessage(s, role)}`,
      ...(resume ? [`FRESH MESSAGE: ${startMessage(s, role)}`] : []),
      "AFTER: when the agent returns, run `aw sm next` again. Don't act on the agent's reply — the state is the source of truth.",
    ],
  };
}

export function nextAction(ctx: Ctx, s: TaskState | null): NextAction {
  if (!s) {
    return {
      kind: "intake",
      lines: [
        "No active task. Get the task text from the user (message or file), then:",
        '`aw sm new --title "<short title>" [--id <TICKET-ID>] [--mode tdd|light] [--source manual|file|jira --ref <ref>] [--requirements <file>]`',
      ],
    };
  }
  const role = roleForStatus(s.status);
  if (role?.phase === "ready") return spawn(ctx, s, role.role);
  if (role?.phase === "working") {
    const run = activeRun(s);
    const agent = run?.agentId ? `agent ${run.agentId}` : "the agent (id unknown)";
    return {
      kind: "recover-agent",
      lines: [
        `Run ${run?.id ?? "?"} of ${agentName(role.role)} is still open${run?.stoppedWithoutSubmit ? " — the agent stopped without submitting" : ""}.`,
        "If the agent is still working, wait for it. If it already returned, it did not finish the protocol:",
        `- resume ${agent} with SendMessage: "${run ? recoverMessage(run) : ""}"`,
        '- or discard the run and start the step again: `aw sm reset --note "<why>"`',
      ],
    };
  }
  switch (s.status) {
    case Status.enum.PLANNING:
      return {
        kind: "plan",
        lines: [
          "1. Make sure requirements.md holds the task text verbatim.",
          "2. Research the code and docs, draft the plan JSON (`aw schema plan`), then `aw sm plan --file <plan.json>`.",
        ],
      };
    case Status.enum.AWAITING_APPROVAL:
      return {
        kind: "user-approval",
        lines: [
          "Show the user plan.md (summary, acceptance criteria, contract, mode) and ask for approval.",
          "Approved → `aw sm approve` (the user confirms the command). Changes → revise the JSON and `aw sm plan --file` again.",
        ],
      };
    case Status.enum.DOCS_CHECK:
      return {
        kind: "docs-check",
        lines: [
          "Check that documentation matches the change: the docs index in the config, the coder's docsUpdated, the diff.",
          "Write the docs-check JSON (`aw schema docs`) and run `aw sm docs --file <docs.json>`.",
          ...ctx.config.docs.map((d) => `- ${d.path} — ${d.when}`),
        ],
      };
    case Status.enum.AWAITING_ACCEPTANCE:
      return {
        kind: "user-acceptance",
        lines: [
          "Summarize the result for the user (`aw show`): what changed, tests, review verdicts, open questions, follow-ups.",
          "Accepted → `aw sm accept` (the user confirms the command).",
          'Changes wanted → one note per remark: `aw sm note --for coder|tester --text "<remark>"`, then `aw sm reopen --to READY_FOR_CODING|READY_FOR_TESTS|PLANNING --note "<one-line summary>"`.',
        ],
      };
    case Status.enum.BLOCKED:
      return {
        kind: "resolve-block",
        lines: [
          `Blocked from ${s.blocked?.from}: ${s.blocked?.reason}`,
          "Explain the reason to the user and get a decision, then:",
          '`aw sm unblock --to <STATUS> --note "<decision>"` (the note goes to the agent that works next), or `aw sm cancel --reason "<why>"`.',
        ],
      };
    case Status.enum.DONE:
    case Status.enum.CANCELLED:
      return {
        kind: "archive",
        lines: ["Write a short retro JSON (`aw schema retro`), then `aw sm archive --retro <retro.json>`."],
      };
    default:
      return { kind: "resolve-block", lines: [`Unexpected status ${s.status}. Run \`aw show\` and ask the user.`] };
  }
}

export function formatNext(s: TaskState | null, a: NextAction): string {
  const head = s ? [`TASK: ${s.id} · ${s.title}`, `MODE: ${s.mode}   STATUS: ${s.status}`] : [];
  return [...head, `NEXT: ${a.kind}`, ...a.lines].join("\n");
}
