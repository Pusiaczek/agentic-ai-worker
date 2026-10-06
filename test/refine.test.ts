import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { RefinementState } from "../src/schema/refinement";
import { EXIT } from "../src/util/errors";
import {
  cli,
  expectOk,
  makeProject,
  PROPOSAL,
  type Proposal,
  REFINE_OUT,
  refinement,
  SLICE,
  sliceFile,
  toProposedRefinement,
  toWorkingRefinement,
  write,
} from "./helpers";

const readText = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const exists = (dir: string, file: string) => fs.existsSync(path.join(dir, file));

/** Writes `proposal` where the product owner would and runs `aw refine submit`. Invalid proposals are welcome. */
function submit(dir: string, proposal: unknown) {
  write(dir, PROPOSAL, proposal);
  return cli(dir, ["refine", "submit"]);
}

/** REFINE_OUT with the item at `index` (0-based) changed by `change`. */
function withItem(index: number, change: (item: Proposal["items"][number]) => Proposal["items"][number]): Proposal {
  return { ...REFINE_OUT, items: REFINE_OUT.items.map((item, position) => (position === index ? change(item) : item)) };
}

/** The latest revision of the SLICE refinement; fails the test when there is none. */
function latestRevision(dir: string): RefinementState["revisions"][number] {
  const revision = refinement(dir).revisions.at(-1);
  if (!revision) throw new Error("the refinement has no revision");
  return revision;
}

describe("aw refine: starting", () => {
  it("creates the refinement in .tasks/refinements/<id>, copies the slice text, and waits for the product owner", () => {
    const dir = makeProject();
    write(dir, "slice.md", "Users module.\n");
    const created = expectOk(cli(dir, ["refine", "new", "--title", "Users module", "--id", SLICE, "--input", "slice.md"]));

    expect(created.out).toContain("NEXT: spawn-po");
    expect(readText(dir, sliceFile("input.md"))).toBe("Users module.\n");
    expect(refinement(dir)).toMatchObject({ status: "DRAFT", source: { kind: "file", ref: "slice.md" } });
  });

  it("asks for the slice text first, and keeps several refinements side by side", () => {
    const dir = makeProject();
    expect(expectOk(cli(dir, ["refine", "new", "--title", "First", "--id", "first"])).out).toContain("NEXT: write-input");
    expect(cli(dir, ["refine", "start-agent", "first"]).code).toBe(EXIT.VALIDATION);
    expectOk(cli(dir, ["refine", "new", "--title", "Second", "--id", "second"]));

    const next = expectOk(cli(dir, ["refine", "next"])).out;
    expect(next).toContain("NEXT: choose");
    expect(next).toContain("first · DRAFT · First");
    expect(next).toContain("second · DRAFT · Second");
    expect(cli(dir, ["refine", "new", "--title", "Again", "--id", "first"]).code).toBe(EXIT.USAGE);
  });
});

describe("aw refine: the product owner's run", () => {
  it("starts a run with a briefing, and allows one agent at a time", () => {
    const dir = makeProject();
    toWorkingRefinement(dir);

    expect(refinement(dir)).toMatchObject({ status: "WORKING", runs: [{ id: "R-1", state: "active" }] });
    const briefing = readText(dir, sliceFile("briefing.md"));
    expect(briefing).toContain(sliceFile("input.md"));
    expect(briefing).toContain(`Write your proposal as JSON to ${PROPOSAL}`);
    expect(briefing).toContain("At most 8 acceptance criteria per item");
    expect(briefing).toContain('"prerequisiteFor"');

    write(dir, "other.md", "Orders.\n");
    expectOk(cli(dir, ["refine", "new", "--title", "Orders", "--id", "orders", "--input", "other.md"]));
    const second = cli(dir, ["refine", "start-agent", "orders"]);
    expect(second.code).toBe(EXIT.STATUS_MISMATCH);
    expect(second.err).toContain(`Refinement ${SLICE} already has a product owner at work`);
  });

  it("accepts a valid proposal as a revision with item IDs, and asks the user to review it", () => {
    const dir = makeProject();
    toProposedRefinement(dir);

    const revision = latestRevision(dir);
    expect(refinement(dir).status).toBe("PROPOSED");
    expect(revision.items.map((item) => item.id)).toEqual(["I-1", "I-2", "I-3"]);
    expect(revision.items[1]?.dependsOn).toEqual(["I-1"]);
    expect(revision.coverage).toEqual([
      { requirement: "Users can be created and read.", items: ["I-2"] },
      { requirement: "Users can be listed.", items: ["I-3"] },
    ]);
    expect(exists(dir, sliceFile("revisions/r1.json"))).toBe(true);
    expect(readText(dir, sliceFile("proposal.md"))).toContain("### I-2 · Create and read a user");
    expect(expectOk(cli(dir, ["refine", "next"])).out).toContain("NEXT: user-review");
  });

  it("turns the user's notes into a revision the next agent must answer", () => {
    const dir = makeProject();
    toProposedRefinement(dir);
    expectOk(cli(dir, ["refine", "note", SLICE, "--text", "Merge listing into the second item."]));
    expect(refinement(dir).status).toBe("DRAFT");
    expect(expectOk(cli(dir, ["refine", "next", SLICE])).out).toContain("answer the user's notes: N-1");

    expectOk(cli(dir, ["refine", "start-agent", SLICE]));
    expect(exists(dir, PROPOSAL)).toBe(false); // the old proposal can't be submitted again by mistake
    const briefing = readText(dir, sliceFile("briefing.md"));
    expect(briefing).toContain("- N-1: Merge listing into the second item.");
    expect(briefing).toContain("## Previous proposal (revision 1)");

    const unanswered = submit(dir, REFINE_OUT);
    expect(unanswered.code).toBe(EXIT.VALIDATION);
    expect(unanswered.err).toContain("addressedNotes: missing N-1");
    expectOk(submit(dir, { ...REFINE_OUT, addressedNotes: [{ noteId: "N-1", note: "Kept apart: listing has its own paging rules." }] }));
    expect(latestRevision(dir).revision).toBe(2);
  });

  it("discards an unfinished run with reset and gives its notes to the next one", () => {
    const dir = makeProject();
    toProposedRefinement(dir);
    expectOk(cli(dir, ["refine", "note", SLICE, "--text", "Smaller items."]));
    expectOk(cli(dir, ["refine", "start-agent", SLICE]));
    expect(expectOk(cli(dir, ["refine", "next"])).out).toContain("NEXT: recover-agent");

    expectOk(cli(dir, ["refine", "reset", SLICE]));
    const state = refinement(dir);
    expect(state.status).toBe("DRAFT");
    expect(state.runs.at(-1)?.state).toBe("abandoned");
    expect(state.notes[0]?.consumedByRun).toBeUndefined();
    expect(cli(dir, ["refine", "submit"]).code).toBe(EXIT.STATUS_MISMATCH);
  });
});

describe("aw refine submit: checks beyond the schema", () => {
  /** The item at `index` of REFINE_OUT; fails the test when there is none. */
  function itemAt(index: number): Proposal["items"][number] {
    const item = REFINE_OUT.items[index];
    if (!item) throw new Error(`REFINE_OUT has no item ${index}`);
    return item;
  }

  const cases: [label: string, proposal: unknown, error: string][] = [
    ["an unknown field", { ...REFINE_OUT, estimate: 5 }, "does not match the schema"],
    ["a dependency on a later item", withItem(1, (item) => ({ ...item, dependsOn: [3] })), "dependsOn: 3 is not an earlier item"],
    [
      "too many acceptance criteria",
      withItem(1, (item) => ({ ...item, acceptanceCriteria: ["a", "b", "c"] })),
      "3 acceptance criteria, the limit is 2",
    ],
    ["too many items", { ...REFINE_OUT, items: [...REFINE_OUT.items, { ...itemAt(2), title: "Fourth" }] }, "4 items, the limit is 3"],
    ["a duplicate title", withItem(2, (item) => ({ ...item, title: "create and READ a user" })), "the same title as item 2"],
    [
      "coverage pointing past the last item",
      { ...REFINE_OUT, coverage: [...REFINE_OUT.coverage, { requirement: "Export.", items: [9] }] },
      "9 is not an item position (1–3)",
    ],
    [
      "an item that delivers nothing and prepares nothing",
      withItem(0, ({ prerequisiteFor: _dropped, ...item }) => item),
      'items[0] ("Test database") delivers nothing from the slice',
    ],
    [
      "a prerequisite no later item needs",
      withItem(1, (item) => ({ ...item, dependsOn: [] })),
      "has prerequisiteFor, but no later item lists 1 in dependsOn",
    ],
    ["an answer to a note nobody asked about", { ...REFINE_OUT, addressedNotes: [{ noteId: "N-7", note: "Done." }] }, "N-7 was not assigned to this run"],
  ];

  it.each(cases)("rejects %s and keeps the run open", (_label, proposal, error) => {
    const dir = makeProject({ refine: { maxCriteriaPerItem: 2, maxItems: 3 } });
    toWorkingRefinement(dir);

    const result = submit(dir, proposal);

    expect(result.code).toBe(EXIT.VALIDATION);
    expect(result.err).toContain(error);
    expect(refinement(dir).status).toBe("WORKING");
  });

  it("asks for the proposal file when the agent hasn't written it", () => {
    const dir = makeProject();
    toWorkingRefinement(dir);

    const result = cli(dir, ["refine", "submit"]);

    expect(result.code).toBe(EXIT.VALIDATION);
    expect(result.err).toContain(`${PROPOSAL} does not exist`);
  });
});

describe("aw refine: approving and cancelling", () => {
  it("writes one task file per item, in delivery order, with the slice as context", () => {
    const dir = makeProject();
    toProposedRefinement(dir);

    const approved = expectOk(cli(dir, ["refine", "approve", SLICE])).out;

    expect(refinement(dir)).toMatchObject({ status: "APPROVED", approvedRevision: 1 });
    expect(approved).toContain(sliceFile("items/01-test-database.md"));
    const second = readText(dir, sliceFile("items/02-create-and-read-a-user.md"));
    expect(second).toContain("# Create and read a user");
    expect(second).toContain("**Depends on:** I-1 Test database");
    expect(second).toContain("2. **I-2 Create and read a user** ← this task");
    expect(second).toContain("> Users can be created and read.");
    expect(second).not.toContain("**Prerequisite for:**");
    expect(readText(dir, sliceFile("items/01-test-database.md"))).toContain("**Prerequisite for:** Items 2 and 3 test against the database.");

    expect(cli(dir, ["refine", "approve", SLICE]).code).toBe(EXIT.STATUS_MISMATCH);
    expect(expectOk(cli(dir, ["refine", "next", SLICE])).out).toContain("NEXT: done");
    expect(expectOk(cli(dir, ["refine", "show", SLICE])).out).toContain(`→ ${sliceFile("items/03-list-users.md")}`);
  });

  it("cancels a refinement, after which nothing waits for a step", () => {
    const dir = makeProject();
    toWorkingRefinement(dir);

    expectOk(cli(dir, ["refine", "cancel", SLICE, "--reason", "Not needed."]));

    expect(refinement(dir).status).toBe("CANCELLED");
    expect(refinement(dir).runs[0]?.state).toBe("abandoned");
    expect(expectOk(cli(dir, ["refine", "next"])).out).toContain("NEXT: intake");
  });

  it("detects a refinement.json edited outside the CLI", () => {
    const dir = makeProject();
    toProposedRefinement(dir);
    const file = sliceFile("refinement.json");
    write(dir, file, readText(dir, file).replace('"PROPOSED"', '"APPROVED"'));

    const result = cli(dir, ["refine", "next", SLICE]);

    expect(result.code).toBe(EXIT.TAMPERED);
    expect(result.err).toContain("refinement.json of refinement users-slice was modified outside the aw CLI");
  });

  it("prints the proposal schema with an example", () => {
    const out = expectOk(cli(makeProject(), ["schema", "refine"])).out;
    expect(out).toContain("JSON Schema for refine");
    expect(out).toContain('"prerequisiteFor"');
    expect(out).toContain("Example:");
  });
});
