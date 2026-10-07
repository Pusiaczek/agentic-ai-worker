/** `aw refine next`: what the orchestrator (the /aw:refine skill) does next for a refinement. Read-only. */
import * as path from "node:path";
import { type RefinementState, RefinementStatus } from "../schema/refinement";
import { readTextIfExists } from "../util/fsx";
import { type Ctx, rel } from "./project";
import { contextDocFiles } from "./refinementContext";
import { activeRefinementRun, latestRevision, pendingRefinementNotes, writtenInput } from "./refinementMachine";
import { itemFileName } from "./refinementRender";
import { refinementPaths, type RefinementRef } from "./refinementStore";

export interface RefinementNextAction {
  kind: "intake" | "choose" | "write-input" | "set-context" | "spawn-po" | "recover-agent" | "user-review" | "done" | "cancelled";
  lines: string[];
}

export function intakeAction(): RefinementNextAction {
  return {
    kind: "intake",
    lines: [
      "No refinement waits for a step. Get the slice description from the user (message or file), then:",
      '`aw refine new --title "<short title>" [--id <id>] [--input <file>]`',
    ],
  };
}

export function chooseAction(inProgress: { ref: RefinementRef; state: RefinementState }[]): RefinementNextAction {
  return {
    kind: "choose",
    lines: [
      "Several refinements wait for a step. Ask the user which one, then run `aw refine next <id>`:",
      ...inProgress.map(({ state }) => `- ${state.id} · ${state.status} · ${state.title}`),
    ],
  };
}

/** The product owner has no project documentation to read: ask the user where it is, or write it with them. */
function setContextAction(ctx: Ctx, s: RefinementState): RefinementNextAction {
  return {
    kind: "set-context",
    lines: [
      `The product owner reads the project documentation in full before every split, but refine.contextDocs (${ctx.config.refine.contextDocs.join(", ")}) matches no files.`,
      "Ask the user where it is: a directory holding only the documents the product owner should read (product overview, domains, the list of planned slices).",
      "Then either move the documents there, or set refine.contextDocs in .claude/aw.config.json to globs that match them.",
      "If the project has no such documentation yet, write a short product overview with the user first: purpose, users, domain terms, planned slices.",
      `Then run \`aw refine next ${s.id}\`.`,
    ],
  };
}

export function refinementNextAction(ctx: Ctx, ref: RefinementRef, s: RefinementState): RefinementNextAction {
  const paths = refinementPaths(ref);
  switch (s.status) {
    case RefinementStatus.enum.DRAFT: {
      if (!writtenInput(readTextIfExists(paths.input))) {
        return {
          kind: "write-input",
          lines: [
            `Write the slice description into ${rel(ctx, paths.input)} VERBATIM, as the user or the ticket gave it. Don't summarize it.`,
            `Then run \`aw refine next ${s.id}\`.`,
          ],
        };
      }
      if (!contextDocFiles(ctx).length) return setContextAction(ctx, s);
      const notes = pendingRefinementNotes(s);
      return {
        kind: "spawn-po",
        lines: [
          `Run \`aw refine start-agent ${s.id}\`. It starts the product owner's run and prints the AGENT and MESSAGE to spawn.`,
          ...(notes.length ? [`The run will have to answer the user's notes: ${notes.map((note) => note.id).join(", ")}.`] : []),
        ],
      };
    }
    case RefinementStatus.enum.WORKING: {
      const run = activeRefinementRun(s);
      return {
        kind: "recover-agent",
        lines: [
          `The product owner's run ${run?.id ?? "?"} has no accepted proposal yet${run?.stoppedWithoutSubmit ? " and the agent stopped" : ""}.`,
          `If the agent has already returned, run \`aw refine reset ${s.id}\`, then \`aw refine start-agent ${s.id}\` for a fresh agent.`,
        ],
      };
    }
    case RefinementStatus.enum.PROPOSED: {
      const revision = latestRevision(s);
      return {
        kind: "user-review",
        lines: [
          `Show the user the proposal ${rel(ctx, paths.proposalView)} (revision ${revision?.revision ?? "?"}, ${revision?.items.length ?? 0} items): the items table, then open questions, out-of-scope parts, and anything the coverage misses.`,
          "Ask with AskUserQuestion: Approve / Changes / Cancel.",
          `- Approve: \`aw refine approve ${s.id}\` (the user confirms the prompt).`,
          `- Changes: one \`aw refine note ${s.id} --text "<remark>"\` per remark, then \`aw refine next ${s.id}\`.`,
          `- Cancel: \`aw refine cancel ${s.id} --reason "<why>"\`.`,
        ],
      };
    }
    case RefinementStatus.enum.APPROVED: {
      const revision = s.revisions.find((candidate) => candidate.revision === s.approvedRevision);
      return {
        kind: "done",
        lines: [
          `Approved revision ${s.approvedRevision}. Task files, in delivery order (start each with /aw:scrum-master <file>):`,
          ...(revision?.items ?? []).map((item) => `- ${rel(ctx, path.join(paths.items, itemFileName(item)))}`),
        ],
      };
    }
    case RefinementStatus.enum.CANCELLED:
      return { kind: "cancelled", lines: ["The refinement was cancelled. Nothing to do."] };
  }
}

export function formatRefinementNext(s: RefinementState | null, action: RefinementNextAction): string {
  const head = s ? [`REFINEMENT: ${s.id} · ${s.title}`, `STATUS: ${s.status}`] : [];
  return [...head, `NEXT: ${action.kind}`, ...action.lines].join("\n");
}
