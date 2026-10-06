/**
 * `aw refine …` — splitting a larger feature ("vertical slice") into small tasks with the aw:product-owner agent,
 * before they enter the pipeline. Independent of tasks. The main session runs everything except `submit`,
 * which only the product owner runs; hooks enforce that.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Ctx, loadCtx, rel } from "../core/project";
import {
  abandonActiveRun,
  activeRefinementRun,
  addRefinementEvent,
  INPUT_PLACEHOLDER,
  latestRevision,
  nextRefinementId,
  pendingRefinementNotes,
  requireStatus,
  toRevision,
  writtenInput,
} from "../core/refinementMachine";
import { chooseAction, formatRefinementNext, intakeAction, refinementNextAction } from "../core/refinementNext";
import { itemFileName, renderItem, renderProposal, renderRefinementBriefing } from "../core/refinementRender";
import {
  findWorkingRefinement,
  listRefinements,
  mutateRefinement,
  readRefinement,
  refinementPaths,
  type RefinementRef,
  refinementRef,
  requireRefinement,
  writeRefinement,
} from "../core/refinementStore";
import { checkRefineOutput } from "../core/validate";
import type { Io } from "../io";
import { RefineAction } from "../schema/commands";
import { RefineOutput } from "../schema/outputs";
import {
  FINAL_REFINEMENT_STATUSES,
  RefinementActor,
  RefinementEventName,
  RefinementId,
  type RefinementRevision,
  type RefinementRun,
  RefinementRunState,
  RefinementSourceKind,
  type RefinementState,
  RefinementStatus,
} from "../schema/refinement";
import { type Args, bool, parseArgs, requireStr, str } from "../util/args";
import { AwError, EXIT } from "../util/errors";
import { ensureDir, nowIso, readTextIfExists, slugify, today, writeFileAtomic } from "../util/fsx";
import { parseInput, readInputJson } from "./shared";

export const PRODUCT_OWNER_AGENT = "aw:product-owner";

const USAGE = `aw refine <command>
  new --title "<t>" [--id <id>] [--input <file>]   start a refinement; the slice text goes to input.md
  next [<id>]                      what to do now
  start-agent <id>                 start the product owner's run; prints the agent to spawn
  submit                           (aw:product-owner only) check proposal.json and record it
  note <id> --text "<remark>"      the user's remark for the next revision
  approve <id>                     the user approved the split: write the task files (asks the user to confirm)
  cancel <id> --reason "<r>"       abandon the refinement
  reset <id>                       discard an unfinished product-owner run
  show [<id>] [--json]             list the refinements, or one refinement's items`;

export function refineCommand(argv: string[], io: Io): number {
  const [word, ...rest] = argv;
  const action = RefineAction.safeParse(word);
  if (!action.success) throw new AwError(word ? `Unknown command: aw refine ${word}` : "Missing the refine command.", EXIT.USAGE, USAGE);
  const args = parseArgs(rest, ["json"]);
  const ctx = loadCtx(io.cwd);
  switch (action.data) {
    case RefineAction.enum.new: return refineNew(ctx, args, io);
    case RefineAction.enum.next: return refineNext(ctx, args, io);
    case RefineAction.enum["start-agent"]: return refineStartAgent(ctx, args, io);
    case RefineAction.enum.submit: return refineSubmit(ctx, io);
    case RefineAction.enum.note: return refineNote(ctx, args, io);
    case RefineAction.enum.approve: return refineApprove(ctx, args, io);
    case RefineAction.enum.cancel: return refineCancel(ctx, args, io);
    case RefineAction.enum.reset: return refineReset(ctx, args, io);
    case RefineAction.enum.show: return refineShow(ctx, args, io);
  }
}

function printNext(ctx: Ctx, ref: RefinementRef, s: RefinementState, io: Io): void {
  io.out(`\n${formatRefinementNext(s, refinementNextAction(ctx, ref, s))}`);
}

function refineNew(ctx: Ctx, args: Args, io: Io): number {
  const usage = 'aw refine new --title "<title>" [--id <id>] [--input <file>]';
  const title = requireStr(args, "title", usage);
  const id = str(args, "id") ?? `${today()}-${slugify(title)}`;
  if (!RefinementId.safeParse(id).success) throw new AwError(`Invalid refinement id "${id}" (letters, digits, . _ - only).`, EXIT.USAGE);
  const ref = refinementRef(ctx, id);
  if (fs.existsSync(ref.dir)) throw new AwError(`${rel(ctx, ref.dir)} already exists.`, EXIT.USAGE, "Pick another --id or title.");

  const inputFile = str(args, "input");
  let input = INPUT_PLACEHOLDER;
  if (inputFile) {
    const abs = path.resolve(io.cwd, inputFile);
    if (!fs.existsSync(abs)) throw new AwError(`Input file not found: ${inputFile}`, EXIT.USAGE);
    input = fs.readFileSync(abs, "utf8");
  }
  const paths = refinementPaths(ref);
  ensureDir(ref.dir);
  fs.writeFileSync(paths.input, input, "utf8");

  const now = nowIso();
  const s: RefinementState = {
    schemaVersion: 1,
    id,
    title,
    source: inputFile ? { kind: RefinementSourceKind.enum.file, ref: inputFile } : { kind: RefinementSourceKind.enum.manual },
    status: RefinementStatus.enum.DRAFT,
    createdAt: now,
    updatedAt: now,
    runs: [],
    revisions: [],
    notes: [],
    history: [],
    counters: { run: 0, note: 0 },
  };
  addRefinementEvent(s, RefinementActor.enum["scrum-master"], RefinementEventName.enum.refinement_created, inputFile ? `input from ${inputFile}` : undefined);
  writeRefinement(ref, s);

  io.out(`Created refinement ${id} in ${rel(ctx, ref.dir)}`);
  io.out(`Input: ${rel(ctx, paths.input)}${inputFile ? " (copied)" : " — write the slice description there VERBATIM"}`);
  printNext(ctx, ref, s, io);
  return EXIT.OK;
}

function refineNext(ctx: Ctx, args: Args, io: Io): number {
  const id = args.positionals[0];
  if (id) {
    const ref = requireRefinement(ctx, id, "aw refine next [<id>]");
    const s = readRefinement(ref);
    io.out(formatRefinementNext(s, refinementNextAction(ctx, ref, s)));
    return EXIT.OK;
  }
  const waiting = listRefinements(ctx)
    .map((ref) => ({ ref, state: readRefinement(ref) }))
    .filter(({ state }) => !FINAL_REFINEMENT_STATUSES.includes(state.status));
  const only = waiting.length === 1 ? waiting[0] : undefined;
  if (only) io.out(formatRefinementNext(only.state, refinementNextAction(ctx, only.ref, only.state)));
  else if (waiting.length === 0) io.out(formatRefinementNext(null, intakeAction()));
  else io.out(formatRefinementNext(null, chooseAction(waiting)));
  return EXIT.OK;
}

function refineStartAgent(ctx: Ctx, args: Args, io: Io): number {
  const ref = requireRefinement(ctx, args.positionals[0], "aw refine start-agent <id>");
  const working = findWorkingRefinement(ctx);
  if (working && working.ref.id !== ref.id) {
    throw new AwError(
      `Refinement ${working.ref.id} already has a product owner at work; one agent at a time.`,
      EXIT.STATUS_MISMATCH,
      `Wait for it to finish, or discard its run with \`aw refine reset ${working.ref.id}\`.`,
    );
  }
  const paths = refinementPaths(ref);
  const { state, run } = mutateRefinement(ref, (s) => {
    requireStatus(s, [RefinementStatus.enum.DRAFT], RefineAction.enum["start-agent"]);
    if (!writtenInput(readTextIfExists(paths.input))) {
      throw new AwError(`${rel(ctx, paths.input)} is empty. Write the slice description there first.`, EXIT.VALIDATION);
    }
    const run: RefinementRun = {
      id: nextRefinementId(s, "run", "R"),
      state: RefinementRunState.enum.active,
      startedAt: nowIso(),
      consumedNotes: [],
      stopBlocks: 0,
    };
    for (const note of pendingRefinementNotes(s)) {
      note.consumedByRun = run.id;
      run.consumedNotes.push(note.id);
    }
    s.runs.push(run);
    s.status = RefinementStatus.enum.WORKING;
    addRefinementEvent(s, RefinementActor.enum["scrum-master"], RefinementEventName.enum.agent_started, run.id);
    return { state: s, run };
  });

  // A proposal left from the previous revision must not be submitted again by mistake; revisions/ keeps a copy.
  fs.rmSync(paths.proposal, { force: true });
  writeFileAtomic(paths.briefing, renderRefinementBriefing(ctx, state, ref, run));

  io.out(`Product-owner run ${run.id} started for refinement ${ref.id}.`);
  io.out(
    [
      `AGENT: ${PRODUCT_OWNER_AGENT}`,
      `HOW: spawn a fresh ${PRODUCT_OWNER_AGENT} (Agent tool, run_in_background: false).`,
      `MESSAGE: You are the product owner for refinement ${ref.id} (run ${run.id}). Read ${rel(ctx, paths.briefing)} first and follow it.`,
      `AFTER: when the agent returns, run \`aw refine next ${ref.id}\`. Don't act on the agent's reply — the state is the source of truth.`,
    ].join("\n"),
  );
  return EXIT.OK;
}

function refineSubmit(ctx: Ctx, io: Io): number {
  const working = findWorkingRefinement(ctx);
  if (!working) {
    throw new AwError(
      "No refinement has an active product-owner run.",
      EXIT.STATUS_MISMATCH,
      "Only the aw:product-owner agent submits, after the orchestrator ran `aw refine start-agent <id>`.",
    );
  }
  const { ref } = working;
  const paths = refinementPaths(ref);
  const proposalFile = rel(ctx, paths.proposal);
  if (!fs.existsSync(paths.proposal)) {
    throw new AwError(`${proposalFile} does not exist. Write your proposal there first (Write tool).`, EXIT.VALIDATION);
  }
  const output = parseInput(RefineOutput, readInputJson(io, paths.proposal), proposalFile, "refine");

  const { state, revision } = mutateRefinement(ref, (s) => {
    requireStatus(s, [RefinementStatus.enum.WORKING], RefineAction.enum.submit);
    const run = activeRefinementRun(s);
    if (!run) throw new AwError(`Refinement ${s.id} has no active run.`, EXIT.STATUS_MISMATCH);
    const errors = checkRefineOutput(ctx.config.refine, output, run.consumedNotes);
    if (errors.length) {
      throw new AwError(
        `${proposalFile} was not accepted:\n${errors.map((error) => `  - ${error}`).join("\n")}`,
        EXIT.VALIDATION,
        "Fix the file and run `aw refine submit` again.",
      );
    }
    const revision: RefinementRevision = toRevision(s, run, output);
    s.revisions.push(revision);
    run.state = RefinementRunState.enum.submitted;
    run.finishedAt = nowIso();
    s.status = RefinementStatus.enum.PROPOSED;
    const summary = `revision ${revision.revision}, ${revision.items.length} items`;
    addRefinementEvent(s, RefinementActor.enum["product-owner"], RefinementEventName.enum.proposal_submitted, summary);
    return { state: s, revision };
  });

  ensureDir(paths.revisions);
  fs.copyFileSync(paths.proposal, path.join(paths.revisions, `r${revision.revision}.json`));
  writeFileAtomic(paths.proposalView, renderProposal(state, revision));
  io.out(
    `Proposal accepted as revision ${revision.revision} of refinement ${ref.id}: ${revision.items.length} items. Reply with ONE line, e.g. "product-owner ${revision.runId}: proposed ${revision.items.length} items".`,
  );
  return EXIT.OK;
}

function refineNote(ctx: Ctx, args: Args, io: Io): number {
  const usage = 'aw refine note <id> --text "<remark>"';
  const ref = requireRefinement(ctx, args.positionals[0], usage);
  const text = requireStr(args, "text", usage);
  const note = mutateRefinement(ref, (s) => {
    requireStatus(s, [RefinementStatus.enum.PROPOSED, RefinementStatus.enum.DRAFT], RefineAction.enum.note);
    const note = { id: nextRefinementId(s, "note", "N"), text, at: nowIso() };
    s.notes.push(note);
    if (s.status === RefinementStatus.enum.PROPOSED) s.status = RefinementStatus.enum.DRAFT;
    addRefinementEvent(s, RefinementActor.enum.user, RefinementEventName.enum.note_added, note.id);
    return note;
  });
  io.out(`Note ${note.id} queued for the next product-owner run of ${ref.id}.`);
  return EXIT.OK;
}

function refineApprove(ctx: Ctx, args: Args, io: Io): number {
  const ref = requireRefinement(ctx, args.positionals[0], "aw refine approve <id>");
  const paths = refinementPaths(ref);
  const { state, revision } = mutateRefinement(ref, (s) => {
    requireStatus(s, [RefinementStatus.enum.PROPOSED], RefineAction.enum.approve);
    const revision = latestRevision(s);
    if (!revision) throw new AwError(`Refinement ${s.id} has no proposal to approve.`, EXIT.STATUS_MISMATCH);
    s.approvedRevision = revision.revision;
    s.status = RefinementStatus.enum.APPROVED;
    addRefinementEvent(s, RefinementActor.enum.user, RefinementEventName.enum.approved, `revision ${revision.revision}`);
    return { state: s, revision };
  });

  ensureDir(paths.items);
  io.out(`Refinement ${ref.id} approved (revision ${revision.revision}). Task files, in delivery order:`);
  for (const item of revision.items) {
    const file = path.join(paths.items, itemFileName(item));
    writeFileAtomic(file, renderItem(state, revision, item));
    io.out(`- ${rel(ctx, file)}`);
  }
  io.out("Start each with `/aw:scrum-master <file>` when you're ready; the files list their dependencies.");
  return EXIT.OK;
}

function refineCancel(ctx: Ctx, args: Args, io: Io): number {
  const usage = 'aw refine cancel <id> --reason "<why>"';
  const ref = requireRefinement(ctx, args.positionals[0], usage);
  const reason = requireStr(args, "reason", usage);
  mutateRefinement(ref, (s) => {
    requireStatus(s, [RefinementStatus.enum.DRAFT, RefinementStatus.enum.WORKING, RefinementStatus.enum.PROPOSED], RefineAction.enum.cancel);
    abandonActiveRun(s, `cancelled: ${reason}`);
    s.status = RefinementStatus.enum.CANCELLED;
    addRefinementEvent(s, RefinementActor.enum.user, RefinementEventName.enum.cancelled, reason);
  });
  io.out(`Refinement ${ref.id} cancelled.`);
  return EXIT.OK;
}

function refineReset(ctx: Ctx, args: Args, io: Io): number {
  const ref = requireRefinement(ctx, args.positionals[0], "aw refine reset <id>");
  const runId = mutateRefinement(ref, (s) => {
    requireStatus(s, [RefinementStatus.enum.WORKING], RefineAction.enum.reset);
    const run = activeRefinementRun(s);
    abandonActiveRun(s, "reset by the orchestrator");
    s.status = RefinementStatus.enum.DRAFT;
    addRefinementEvent(s, RefinementActor.enum["scrum-master"], RefinementEventName.enum.agent_reset, run?.id);
    return run?.id ?? "?";
  });
  io.out(`Run ${runId} discarded; refinement ${ref.id} is DRAFT again. Start a fresh agent with \`aw refine start-agent ${ref.id}\`.`);
  return EXIT.OK;
}

function refineShow(ctx: Ctx, args: Args, io: Io): number {
  const id = args.positionals[0];
  if (!id) {
    const all = listRefinements(ctx);
    if (!all.length) {
      io.out("No refinements yet. Start one with `aw refine new` (or /aw:refine).");
      return EXIT.OK;
    }
    for (const ref of all) {
      const s = readRefinement(ref);
      const revision = latestRevision(s);
      io.out(`${s.id} · ${s.status} · ${s.title}${revision ? ` · revision ${revision.revision}, ${revision.items.length} items` : ""}`);
    }
    return EXIT.OK;
  }

  const ref = requireRefinement(ctx, id, "aw refine show [<id>] [--json]");
  const s = readRefinement(ref);
  if (bool(args, "json")) {
    io.out(JSON.stringify(s, null, 2));
    return EXIT.OK;
  }
  const paths = refinementPaths(ref);
  io.out(`${s.id} · ${s.status} · ${s.title}`);
  io.out(`Input: ${rel(ctx, paths.input)}`);
  const approved = s.revisions.find((revision) => revision.revision === s.approvedRevision);
  const shown = approved ?? latestRevision(s);
  if (!shown) {
    io.out("No proposal yet.");
  } else {
    io.out(`Revision ${shown.revision}${approved ? " (approved)" : ""}:`);
    for (const item of shown.items) {
      const dependencies = item.dependsOn.length ? `, depends on ${item.dependsOn.join(", ")}` : "";
      const file = approved ? ` → ${rel(ctx, path.join(paths.items, itemFileName(item)))}` : "";
      io.out(`- ${item.id} ${item.title} [${item.suggestedMode}, ${item.acceptanceCriteria.length} criteria${dependencies}]${file}`);
    }
  }
  const pending = pendingRefinementNotes(s);
  if (pending.length) io.out(`Notes for the next revision: ${pending.map((note) => `${note.id} ${note.text}`).join("; ")}`);
  return EXIT.OK;
}
