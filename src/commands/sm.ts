/** `aw sm …` — orchestrator (scrum-master) commands. Run by the main session only; hooks enforce that. */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  activeRun,
  addEvent,
  addNote,
  firstWorkStatus,
  pendingNotes,
  transition,
} from "../core/machine";
import { formatNext, nextAction } from "../core/next";
import { type Ctx, loadCtx, rel } from "../core/project";
import { renderPlan, renderReport } from "../core/render";
import {
  findActiveTask,
  mutate,
  readBacklog,
  readState,
  requireActiveTask,
  type TaskRef,
  taskPaths,
  withLock,
  writeBacklog,
  writeState,
} from "../core/store";
import type { Io } from "../io";
import { SmAction } from "../schema/commands";
import { DocsCheckInput, DocStatus, DocsVerdict, PlanInput, RetroInput } from "../schema/outputs";
import {
  type BacklogItem,
  BacklogKind,
  BacklogStatus,
  NoteSource,
  type PlanRevision,
  RunState,
  TaskEventName,
  TaskId,
  type TaskState,
} from "../schema/state";
import { Actor, Mode, Role, roleForStatus, Status, stepForWorking, TERMINAL } from "../schema/status";
import { type Args, parseArgs, requireStr, str } from "../util/args";
import { AwError, EXIT } from "../util/errors";
import { ensureDir, nowIso, readTextIfExists, slugify, today, writeFileAtomic } from "../util/fsx";
import { gitInfo, list, parseInput, readInputJson } from "./shared";

export const REQUIREMENTS_PLACEHOLDER =
  "<!-- aw: paste the task text here VERBATIM, exactly as the user / ticket gave it. Do not summarize or rephrase. -->\n";

const USAGE = `aw sm <command>
  new --title "<t>" [--id <id>] [--mode tdd|light] [--source manual|file|jira] [--ref <r>] [--requirements <file>]
  plan --file <plan.json>          submit / revise the plan (see \`aw schema plan\`)
  approve [--note "<n>"]           user approved the plan (asks the user to confirm)
  next                             what to do now
  note --for <role> --text "<t>"   pass feedback to the next run of a role
  block --reason "<r>" | unblock --to <STATUS> [--note "<n>"] | cancel --reason "<r>"
  reset [--note "<n>"]             discard an unfinished agent run, back to its ready status
  docs --file <docs.json>          documentation check result (see \`aw schema docs\`)
  accept [--note "<n>"]            user accepted the result (asks the user to confirm)
  reopen --to PLANNING|READY_FOR_TESTS|READY_FOR_CODING --note "<summary>"   (queue each remark with \`note\` first)
  archive [--retro <retro.json>]   move a DONE/CANCELLED task to the archive
  repair                           accept a manual edit of state.json (asks the user to confirm)`;

export function smCommand(argv: string[], io: Io): number {
  const [word, ...rest] = argv;
  const action = SmAction.safeParse(word);
  if (!action.success) throw new AwError(word ? `Unknown command: aw sm ${word}` : "Missing sm command.", EXIT.USAGE, USAGE);
  const args = parseArgs(rest);
  const ctx = loadCtx(io.cwd);
  switch (action.data) {
    case SmAction.enum.new: return smNew(ctx, args, io);
    case SmAction.enum.plan: return smPlan(ctx, args, io);
    case SmAction.enum.approve: return smApprove(ctx, args, io);
    case SmAction.enum.next: return smNext(ctx, io);
    case SmAction.enum.note: return smNote(ctx, args, io);
    case SmAction.enum.block: return smBlock(ctx, args, io);
    case SmAction.enum.unblock: return smUnblock(ctx, args, io);
    case SmAction.enum.cancel: return smCancel(ctx, args, io);
    case SmAction.enum.reset: return smReset(ctx, args, io);
    case SmAction.enum.docs: return smDocs(ctx, args, io);
    case SmAction.enum.accept: return smAccept(ctx, args, io);
    case SmAction.enum.reopen: return smReopen(ctx, args, io);
    case SmAction.enum.archive: return smArchive(ctx, args, io);
    case SmAction.enum.repair: return smRepair(ctx, io);
  }
}

function expectStatus(s: TaskState, allowed: Status[], action: string): void {
  if (!allowed.includes(s.status)) {
    throw new AwError(`Cannot ${action} in status ${s.status} (allowed: ${allowed.join(", ")}).`, EXIT.STATUS_MISMATCH, "Run `aw sm next`.");
  }
}

function printNext(ctx: Ctx, s: TaskState | null, io: Io): void {
  io.out(`\n${formatNext(s, nextAction(ctx, s))}`);
}

/** Notes consumed by a run that never finished go back to the queue for the next run. */
function releaseNotes(s: TaskState, runId: string): void {
  for (const n of s.notes) if (n.consumedByRun === runId) delete n.consumedByRun;
}

function smNew(ctx: Ctx, args: Args, io: Io): number {
  const usage = 'aw sm new --title "<title>" [--id <id>] [--mode tdd|light] [--source manual|file|jira] [--ref <ref>] [--requirements <file>]';
  const title = requireStr(args, "title", usage);
  const existing = findActiveTask(ctx);
  if (existing) {
    throw new AwError(`Task ${existing.id} is still active.`, EXIT.ERROR, "Finish it (accept or cancel) and archive it first — see `aw sm next`.");
  }
  const id = str(args, "id") ?? `${today()}-${slugify(title)}`;
  if (!TaskId.safeParse(id).success) throw new AwError(`Invalid task id "${id}" (letters, digits, . _ - only).`, EXIT.USAGE);
  const mode = Mode.safeParse(str(args, "mode") ?? ctx.config.flow.defaultMode);
  if (!mode.success) throw new AwError("--mode must be tdd or light.", EXIT.USAGE);
  const reqFile = str(args, "requirements");
  const kind = str(args, "source") ?? (reqFile ? "file" : "manual");
  if (!["manual", "file", "jira"].includes(kind)) throw new AwError("--source must be manual, file or jira.", EXIT.USAGE);
  const sourceRef = str(args, "ref") ?? reqFile;

  const ref: TaskRef = { id, dir: path.join(ctx.activeDir, id) };
  if (fs.existsSync(ref.dir)) throw new AwError(`${rel(ctx, ref.dir)} already exists.`);
  const p = taskPaths(ref);
  ensureDir(p.out);
  ensureDir(p.logs);

  let requirements = REQUIREMENTS_PLACEHOLDER;
  if (reqFile) {
    const abs = path.resolve(io.cwd, reqFile);
    if (!fs.existsSync(abs)) throw new AwError(`Requirements file not found: ${reqFile}`, EXIT.USAGE);
    requirements = fs.readFileSync(abs, "utf8");
  }
  fs.writeFileSync(p.requirements, requirements, "utf8");

  const now = nowIso();
  const s: TaskState = {
    schemaVersion: 1,
    id,
    title,
    mode: mode.data,
    source: { kind: kind as TaskState["source"]["kind"], ...(sourceRef ? { ref: sourceRef } : {}) },
    status: Status.enum.PLANNING,
    createdAt: now,
    updatedAt: now,
    git: gitInfo(ctx),
    plans: [],
    protectedFiles: [],
    runs: [],
    notes: [],
    docsChecks: [],
    history: [],
    lastSpawn: {},
    counters: { run: 0, test: 0, finding: 0, note: 0 },
  };
  addEvent(s, Actor.enum["scrum-master"], TaskEventName.enum.task_created, `mode ${mode.data}, source ${kind}`);
  writeState(ref, s);

  io.out(`Created task ${id} (${mode.data}) in ${rel(ctx, ref.dir)}`);
  io.out(`Requirements: ${rel(ctx, p.requirements)}${reqFile ? " (copied)" : " — write the task text there VERBATIM"}`);
  if (s.git.baseRef === null) io.out("Warning: no git HEAD found — reviewers will rely on the coder's file list.");
  if (s.git.dirtyAtStart) io.out("Warning: the working tree has uncommitted changes; they will mix with the task's changes in `git diff`.");
  printNext(ctx, s, io);
  return EXIT.OK;
}

function smPlan(ctx: Ctx, args: Args, io: Io): number {
  const file = requireStr(args, "file", "aw sm plan --file <plan.json>");
  const input = parseInput(PlanInput, readInputJson(io, file), file, "plan");
  const ref = requireActiveTask(ctx);
  const p = taskPaths(ref);
  const requirements = (readTextIfExists(p.requirements) ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!requirements) {
    throw new AwError(`requirements.md is empty. Write the task text verbatim into ${rel(ctx, p.requirements)} first.`, EXIT.VALIDATION);
  }
  if (input.mode === Mode.enum.tdd && !input.contract.trim()) {
    throw new AwError(
      "tdd mode needs a contract (modules, function signatures, endpoints, error shapes): the tester writes tests against it before any code exists.",
      EXIT.VALIDATION,
    );
  }
  const { acceptanceCriteria, ...rest } = input;

  const s = mutate(ref, (s) => {
    expectStatus(s, [Status.enum.PLANNING, Status.enum.AWAITING_APPROVAL], "submit a plan");
    const revision = s.plans.length + 1;
    const plan: PlanRevision = {
      ...rest,
      revision,
      createdAt: nowIso(),
      acceptanceCriteria: acceptanceCriteria.map((text, i) => ({ id: `AC-${i + 1}`, text })),
    };
    s.plans.push(plan);
    s.mode = input.mode;
    if (input.title) s.title = input.title;
    writeFileAtomic(p.plan, renderPlan(s, plan));
    if (ctx.config.flow.requireApproval[input.mode]) {
      if (s.status === Status.enum.PLANNING) {
        transition(s, Status.enum.AWAITING_APPROVAL, Actor.enum["scrum-master"], `plan revision ${revision}`);
      }
      else addEvent(s, Actor.enum["scrum-master"], TaskEventName.enum.plan_revised, `revision ${revision}`);
    } else {
      s.approvedPlanRevision = revision;
      const reason = `plan revision ${revision} auto-approved (flow.requireApproval.${input.mode} = false)`;
      transition(s, firstWorkStatus(input.mode), Actor.enum["scrum-master"], reason);
    }
    return s;
  });
  const plan = s.plans.at(-1)!;
  io.out(`Plan revision ${plan.revision} saved → ${rel(ctx, p.plan)} (mode ${plan.mode})`);
  io.out(list(plan.acceptanceCriteria.map((a) => `${a.id}: ${a.text}`)));
  printNext(ctx, s, io);
  return EXIT.OK;
}

function smApprove(ctx: Ctx, args: Args, io: Io): number {
  const s = mutate(requireActiveTask(ctx), (s) => {
    expectStatus(s, [Status.enum.AWAITING_APPROVAL], "approve");
    const plan = s.plans.at(-1)!;
    s.approvedPlanRevision = plan.revision;
    transition(s, firstWorkStatus(s.mode), Actor.enum.user, str(args, "note") ?? `plan revision ${plan.revision} approved`);
    return s;
  });
  io.out(`Plan revision ${s.approvedPlanRevision} approved.`);
  printNext(ctx, s, io);
  return EXIT.OK;
}

function smNext(ctx: Ctx, io: Io): number {
  const ref = findActiveTask(ctx);
  const s = ref ? readState(ref) : null;
  io.out(formatNext(s, nextAction(ctx, s)));
  return EXIT.OK;
}

function smNote(ctx: Ctx, args: Args, io: Io): number {
  const usage = 'aw sm note --for tester|reviewer|coder --text "<text>" [--source user|scrum-master]';
  const role = Role.safeParse(requireStr(args, "for", usage));
  if (!role.success) throw new AwError("--for must be tester, reviewer or coder.", EXIT.USAGE);
  const text = requireStr(args, "text", usage);
  const fromScrumMaster = str(args, "source") === NoteSource.enum["scrum-master"];
  const source = fromScrumMaster ? NoteSource.enum["scrum-master"] : NoteSource.enum.user;
  const author = fromScrumMaster ? Actor.enum["scrum-master"] : Actor.enum.user;
  const note = mutate(requireActiveTask(ctx), (s) => {
    if (TERMINAL.includes(s.status)) throw new AwError(`Task is ${s.status}.`, EXIT.STATUS_MISMATCH);
    return addNote(s, role.data, source, text, author);
  });
  io.out(`Note ${note.id} queued for the next ${role.data} run.`);
  return EXIT.OK;
}

function abandonActiveRun(s: TaskState, reason: string): void {
  const run = activeRun(s);
  if (!run) return;
  run.state = RunState.enum.abandoned;
  run.finishedAt = nowIso();
  run.failReason = reason;
  releaseNotes(s, run.id);
}

function smBlock(ctx: Ctx, args: Args, io: Io): number {
  const reason = requireStr(args, "reason", 'aw sm block --reason "<why>"');
  const s = mutate(requireActiveTask(ctx), (s) => {
    abandonActiveRun(s, `blocked: ${reason}`);
    transition(s, Status.enum.BLOCKED, Actor.enum["scrum-master"], reason);
    return s;
  });
  io.out(`Task ${s.id} blocked.`);
  printNext(ctx, s, io);
  return EXIT.OK;
}

function smUnblock(ctx: Ctx, args: Args, io: Io): number {
  const usage = 'aw sm unblock --to <STATUS> [--note "<decision>"]';
  const to = Status.safeParse(requireStr(args, "to", usage));
  if (!to.success) throw new AwError(`--to must be one of: ${Status.options.join(", ")}`, EXIT.USAGE);
  const note = str(args, "note");
  const s = mutate(requireActiveTask(ctx), (s) => {
    expectStatus(s, [Status.enum.BLOCKED], "unblock");
    const wasDispute = s.blocked?.reason.startsWith("test dispute") ?? false;
    transition(s, to.data, Actor.enum.user, note);
    const target = roleForStatus(to.data);
    if (note && target?.phase === "ready") {
      const source = wasDispute ? NoteSource.enum.dispute : NoteSource.enum.block;
      addNote(s, target.role, source, note, Actor.enum.user);
    }
    return s;
  });
  io.out(`Unblocked → ${s.status}.`);
  printNext(ctx, s, io);
  return EXIT.OK;
}

function smCancel(ctx: Ctx, args: Args, io: Io): number {
  const reason = requireStr(args, "reason", 'aw sm cancel --reason "<why>"');
  const s = mutate(requireActiveTask(ctx), (s) => {
    abandonActiveRun(s, `cancelled: ${reason}`);
    transition(s, Status.enum.CANCELLED, Actor.enum.user, reason);
    return s;
  });
  io.out(`Task ${s.id} cancelled.`);
  printNext(ctx, s, io);
  return EXIT.OK;
}

function smReset(ctx: Ctx, args: Args, io: Io): number {
  const s = mutate(requireActiveTask(ctx), (s) => {
    const r = roleForStatus(s.status);
    const step = r?.phase === "working" ? stepForWorking(r.role, s.status) : undefined;
    if (!r || !step) throw new AwError(`Nothing to reset: status ${s.status} is not an agent's working status.`, EXIT.STATUS_MISMATCH);
    const run = activeRun(s);
    abandonActiveRun(s, str(args, "note") ?? "reset by orchestrator");
    transition(s, step.ready, Actor.enum["scrum-master"], str(args, "note") ?? `run ${run?.id ?? "?"} reset`);
    return s;
  });
  io.out(`Reset → ${s.status}.`);
  printNext(ctx, s, io);
  return EXIT.OK;
}

function smDocs(ctx: Ctx, args: Args, io: Io): number {
  const file = requireStr(args, "file", "aw sm docs --file <docs.json>");
  const input = parseInput(DocsCheckInput, readInputJson(io, file), file, "docs");
  const s = mutate(requireActiveTask(ctx), (s) => {
    expectStatus(s, [Status.enum.DOCS_CHECK], "record a docs check");
    s.docsChecks.push({ ...input, at: nowIso() });
    if (input.verdict === DocsVerdict.enum.needs_changes) {
      for (const item of input.items.filter((i) => i.status === DocStatus.enum.missing)) {
        addNote(s, Role.enum.coder, NoteSource.enum["docs-check"], `Update ${item.path}: ${item.note}`, Actor.enum["scrum-master"]);
      }
      transition(s, Status.enum.READY_FOR_CODING, Actor.enum["scrum-master"], "documentation needs changes");
    } else {
      transition(s, Status.enum.AWAITING_ACCEPTANCE, Actor.enum["scrum-master"], "documentation ok");
    }
    return s;
  });
  io.out(`Docs check recorded (${input.verdict}).`);
  printNext(ctx, s, io);
  return EXIT.OK;
}

function smAccept(ctx: Ctx, args: Args, io: Io): number {
  const s = mutate(requireActiveTask(ctx), (s) => {
    expectStatus(s, [Status.enum.AWAITING_ACCEPTANCE], "accept");
    s.acceptedAt = nowIso();
    transition(s, Status.enum.DONE, Actor.enum.user, str(args, "note") ?? "accepted");
    return s;
  });
  io.out(`Task ${s.id} accepted.`);
  printNext(ctx, s, io);
  return EXIT.OK;
}

/**
 * The user reviewed the result and wants changes. Each remark must already be queued as its own note
 * (`aw sm note --for <role>`), so the agent has to answer every one of them separately; --note is the summary for history.
 */
function smReopen(ctx: Ctx, args: Args, io: Io): number {
  const usage = 'aw sm reopen --to PLANNING|READY_FOR_TESTS|READY_FOR_CODING --note "<one-line summary>"';
  const to = requireStr(args, "to", usage);
  const note = requireStr(args, "note", usage);
  if (!["PLANNING", "READY_FOR_TESTS", "READY_FOR_CODING"].includes(to)) throw new AwError(`--to must be PLANNING, READY_FOR_TESTS or READY_FOR_CODING.`, EXIT.USAGE);
  const s = mutate(requireActiveTask(ctx), (s) => {
    expectStatus(s, [Status.enum.AWAITING_ACCEPTANCE], "reopen");
    const target = roleForStatus(to as Status);
    if (target && pendingNotes(s, target.role).length === 0) {
      throw new AwError(
        `No feedback queued for the ${target.role}.`,
        EXIT.USAGE,
        `First add each of the user's remarks as its own note: aw sm note --for ${target.role} --text "<remark>" — then reopen.`,
      );
    }
    transition(s, to as Status, Actor.enum.user, note);
    return s;
  });
  io.out(`Reopened → ${s.status}.`);
  printNext(ctx, s, io);
  return EXIT.OK;
}

function archiveName(ctx: Ctx, id: string): string {
  const base = /^\d{4}-\d{2}-\d{2}/.test(id) ? id : `${today()}_${id}`;
  let name = base;
  for (let i = 2; fs.existsSync(path.join(ctx.archiveDir, name)); i++) name = `${base}-${i}`;
  return name;
}

function collectBacklog(s: TaskState, retroImprovements: string[]): Omit<BacklogItem, "id">[] {
  const at = nowIso();
  const items: Omit<BacklogItem, "id">[] = [];
  const add = (kind: BacklogItem["kind"], text: string, extra: Partial<BacklogItem> = {}) =>
    items.push({ kind, text, taskId: s.id, createdAt: at, status: BacklogStatus.enum.open, ...extra });
  for (const r of s.runs) {
    if (!r.output) continue;
    if (r.role === Role.enum.reviewer) {
      for (const f of r.output.followUps) add(BacklogKind.enum.followUp, f.text, { runId: r.id, role: r.role });
    }
    for (const n of r.output.processNotes) add(BacklogKind.enum.processNote, n, { runId: r.id, role: r.role });
  }
  for (const x of retroImprovements) add(BacklogKind.enum.processImprovement, x, { role: "scrum-master" });
  return items;
}

function smArchive(ctx: Ctx, args: Args, io: Io): number {
  const retroFile = str(args, "retro");
  const retro = retroFile ? parseInput(RetroInput, readInputJson(io, retroFile), retroFile, "retro") : undefined;
  const ref = requireActiveTask(ctx);
  const s = mutate(ref, (s) => {
    expectStatus(s, [...TERMINAL], "archive");
    if (retro) s.retro = { ...retro, at: nowIso() };
    addEvent(s, Actor.enum["scrum-master"], TaskEventName.enum.archived);
    return s;
  });
  writeFileAtomic(taskPaths(ref).report, renderReport(s));

  const backlog = readBacklog(ctx);
  const added = collectBacklog(s, retro?.processImprovements ?? []);
  for (const item of added) {
    backlog.counter += 1;
    backlog.items.push({ ...item, id: `B-${backlog.counter}` });
  }
  writeBacklog(ctx, backlog);

  ensureDir(ctx.archiveDir);
  const dest = path.join(ctx.archiveDir, archiveName(ctx, s.id));
  fs.renameSync(ref.dir, dest);
  io.out(`Archived ${s.id} → ${rel(ctx, dest)} (report.md inside).`);
  if (added.length) io.out(`${added.length} item(s) added to the backlog — \`aw backlog\`.`);
  if (!retro) io.out("No retro recorded. Next time pass --retro <retro.json> (see `aw schema retro`).");
  return EXIT.OK;
}

function smRepair(ctx: Ctx, io: Io): number {
  const ref = requireActiveTask(ctx);
  withLock(ref, () => {
    const s = readState(ref, { verifyHash: false });
    addEvent(s, Actor.enum.user, TaskEventName.enum.state_repaired, "manual edit of state.json accepted");
    writeState(ref, s);
  });
  io.out(`state.json of ${ref.id} re-validated and re-sealed.`);
  return EXIT.OK;
}
