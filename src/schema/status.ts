import { z } from "zod";

export const Status = z.enum([
  "PLANNING",
  "AWAITING_APPROVAL",
  "READY_FOR_TESTS",
  "WRITING_TESTS",
  "READY_FOR_TEST_REVIEW",
  "REVIEWING_TESTS",
  "READY_FOR_CODING",
  "CODING",
  "READY_FOR_CODE_REVIEW",
  "REVIEWING_CODE",
  "DOCS_CHECK",
  "AWAITING_ACCEPTANCE",
  "DONE",
  "BLOCKED",
  "CANCELLED",
]);
export type Status = z.infer<typeof Status>;

export const Mode = z.enum(["tdd", "light"]);
export type Mode = z.infer<typeof Mode>;

export const Role = z.enum(["tester", "reviewer", "coder"]);
export type Role = z.infer<typeof Role>;

export const ReviewTarget = z.enum(["tests", "code"]);
export type ReviewTarget = z.infer<typeof ReviewTarget>;

/** Who caused a history entry. "user" = an explicit human decision relayed by the orchestrator. */
export const Actor = z.enum(["scrum-master", "user", "tester", "reviewer", "coder", "hook"]);
export type Actor = z.infer<typeof Actor>;

const CANCEL: Status[] = ["BLOCKED", "CANCELLED"];

/** Every legal status change. The CLI refuses anything not listed here. */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  PLANNING: ["AWAITING_APPROVAL", "READY_FOR_TESTS", "READY_FOR_CODING", ...CANCEL],
  AWAITING_APPROVAL: ["PLANNING", "READY_FOR_TESTS", "READY_FOR_CODING", ...CANCEL],
  READY_FOR_TESTS: ["WRITING_TESTS", ...CANCEL],
  WRITING_TESTS: ["READY_FOR_TEST_REVIEW", "READY_FOR_TESTS", ...CANCEL],
  READY_FOR_TEST_REVIEW: ["REVIEWING_TESTS", ...CANCEL],
  REVIEWING_TESTS: ["READY_FOR_CODING", "READY_FOR_TESTS", "READY_FOR_TEST_REVIEW", ...CANCEL],
  READY_FOR_CODING: ["CODING", ...CANCEL],
  CODING: ["READY_FOR_CODE_REVIEW", "READY_FOR_CODING", ...CANCEL],
  READY_FOR_CODE_REVIEW: ["REVIEWING_CODE", ...CANCEL],
  REVIEWING_CODE: ["DOCS_CHECK", "AWAITING_ACCEPTANCE", "READY_FOR_CODING", "READY_FOR_CODE_REVIEW", ...CANCEL],
  DOCS_CHECK: ["AWAITING_ACCEPTANCE", "READY_FOR_CODING", ...CANCEL],
  AWAITING_ACCEPTANCE: ["DONE", "PLANNING", "READY_FOR_TESTS", "READY_FOR_CODING", ...CANCEL],
  DONE: [],
  BLOCKED: [
    "PLANNING",
    "AWAITING_APPROVAL",
    "READY_FOR_TESTS",
    "READY_FOR_TEST_REVIEW",
    "READY_FOR_CODING",
    "READY_FOR_CODE_REVIEW",
    "DOCS_CHECK",
    "AWAITING_ACCEPTANCE",
    "CANCELLED",
  ],
  CANCELLED: [],
};

export const TERMINAL: readonly Status[] = ["DONE", "CANCELLED"];

/** Queue status → in-progress status, per agent role. `start` moves ready → working, `submit` leaves working. */
export const ROLE_STEPS: Record<Role, { ready: Status; working: Status; target?: ReviewTarget }[]> = {
  tester: [{ ready: "READY_FOR_TESTS", working: "WRITING_TESTS" }],
  reviewer: [
    { ready: "READY_FOR_TEST_REVIEW", working: "REVIEWING_TESTS", target: "tests" },
    { ready: "READY_FOR_CODE_REVIEW", working: "REVIEWING_CODE", target: "code" },
  ],
  coder: [{ ready: "READY_FOR_CODING", working: "CODING" }],
};

export const WORKING_STATUSES: readonly Status[] = Object.values(ROLE_STEPS).flatMap((steps) =>
  steps.map((s) => s.working),
);

export function stepForReady(role: Role, status: Status) {
  return ROLE_STEPS[role].find((s) => s.ready === status);
}

export function stepForWorking(role: Role, status: Status) {
  return ROLE_STEPS[role].find((s) => s.working === status);
}

export function roleForStatus(status: Status): { role: Role; phase: "ready" | "working"; target?: ReviewTarget } | null {
  for (const role of Role.options) {
    for (const step of ROLE_STEPS[role]) {
      if (step.ready === status) return { role, phase: "ready", target: step.target };
      if (step.working === status) return { role, phase: "working", target: step.target };
    }
  }
  return null;
}
