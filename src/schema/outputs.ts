/**
 * What agents (and the orchestrator) hand to the CLI. Every object is strict: unknown keys are
 * rejected, so a typo in a field name surfaces as a validation error instead of silently vanishing.
 * IDs (tests, findings, notes, acceptance criteria) are assigned by the CLI, never by agents.
 */
import { z } from "zod";
import { Mode } from "./status";

export const AcId = z.string().regex(/^AC-\d+$/, "must look like AC-1");
export const TestId = z.string().regex(/^T-\d+$/, "must look like T-1");
export const FindingId = z.string().regex(/^F-\d+$/, "must look like F-1");
export const NoteId = z.string().regex(/^N-\d+$/, "must look like N-1");

const Text = z.string().trim().min(1);
const FilePath = z.string().trim().min(1);

const common = {
  summary: Text.max(4000).describe("What you did, in a few sentences."),
  openQuestions: z.array(Text).default([]).describe("Questions for the user / orchestrator that you could not resolve."),
  processNotes: z
    .array(Text)
    .default([])
    .describe("What slowed you down or was unclear (docs, plan, tooling). Used to improve the process."),
};

/** Tester and coder must account for every blocking finding and note listed under "Must address" in their briefing. */
const addressed = {
  addressedFindings: z
    .array(z.object({ findingId: FindingId, resolution: z.enum(["fixed", "disputed"]), note: Text }).strict())
    .default([]),
  addressedNotes: z.array(z.object({ noteId: NoteId, note: Text }).strict()).default([]),
};

const UntestedCriterion = z
  .object({ ac: AcId, reason: Text })
  .strict()
  .describe("An acceptance criterion you deliberately did not cover with a test, and why.");

// ---------------------------------------------------------------- tester

export const TestKind = z.enum(["unit", "integration", "e2e", "script", "other"]);

export const TesterTest = z
  .object({
    file: FilePath,
    title: Text.describe("Test name as it appears in the test file."),
    kind: TestKind,
    covers: z.array(AcId).min(1).describe("Acceptance criteria this test verifies."),
    edgeCase: z.boolean().describe("True for boundary / error / unusual-input tests."),
    rationale: Text.optional(),
  })
  .strict();

export const TesterOutput = z
  .object({
    ...common,
    tests: z.array(TesterTest).min(1),
    supportFiles: z
      .array(FilePath)
      .default([])
      .describe("Fixtures/helpers you created that the tests depend on. Protected like the tests."),
    untestedCriteria: z.array(UntestedCriterion).default([]),
    ...addressed,
    commandsRun: z
      .array(z.object({ command: Text, exitCode: z.number().int(), note: Text.optional() }).strict())
      .default([]),
  })
  .strict();
export type TesterOutput = z.infer<typeof TesterOutput>;

// ---------------------------------------------------------------- reviewer

export const Severity = z.enum(["blocker", "major", "minor", "nit"]);
export type Severity = z.infer<typeof Severity>;
export const BLOCKING_SEVERITIES: readonly Severity[] = ["blocker", "major"];
export const isBlocking = (s: Severity) => BLOCKING_SEVERITIES.includes(s);

export const FindingCategory = z.enum([
  "requirements",
  "correctness",
  "edge-cases",
  "error-handling",
  "security",
  "performance",
  "maintainability",
  "conventions",
  "tests",
  "compatibility",
  "docs",
  "readability",
]);

export const FindingBase = z
  .object({
    file: FilePath.optional().describe("Omit for a finding about the change as a whole."),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("A hint only: lines shift as code changes. Omit for a finding about the whole file."),
    endLine: z.number().int().positive().optional(),
    symbol: Text.optional().describe(
      "Function / class / identifier the finding is about, e.g. createLoginRateLimiter. The stable anchor — prefer it whenever the finding concerns specific code.",
    ),
    severity: Severity,
    category: FindingCategory,
    message: Text,
    suggestion: Text.optional(),
    evidence: Text.optional().describe("Concrete proof, e.g. the existing code this duplicates. Required for blocking maintainability findings."),
  })
  .strict();

export const FindingInput = FindingBase.superRefine((f, ctx) => {
  if (f.line !== undefined && f.file === undefined) {
    ctx.addIssue({ code: "custom", path: ["line"], message: "line requires file" });
  }
  if (f.endLine !== undefined && (f.line === undefined || f.endLine < f.line)) {
    ctx.addIssue({ code: "custom", path: ["endLine"], message: "endLine requires line and must be >= line" });
  }
  if (f.category === FindingCategory.enum.maintainability && isBlocking(f.severity) && !f.evidence) {
    ctx.addIssue({
      code: "custom",
      path: ["evidence"],
      message:
        "a blocking maintainability finding needs concrete evidence (existing code it duplicates, pattern it breaks); otherwise lower the severity or move it to followUps",
    });
  }
});

export const ReviewVerdict = z.enum(["approve", "changes_requested"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** The reviewer's verdict on a blocking finding from an earlier round. */
export const PreviousFindingStatus = z.enum(["fixed", "not_fixed", "no_longer_applicable"]);
export type PreviousFindingStatus = z.infer<typeof PreviousFindingStatus>;

/** How well the tests or the code cover one acceptance criterion. */
export const CoverageVerdict = z.enum(["covered", "partial", "missing"]);
export type CoverageVerdict = z.infer<typeof CoverageVerdict>;

export const ReviewerOutput = z
  .object({
    ...common,
    verdict: ReviewVerdict,
    findings: z.array(FindingInput).default([]),
    previousFindings: z
      .array(
        z
          .object({
            id: FindingId,
            status: PreviousFindingStatus,
            note: Text.optional(),
          })
          .strict(),
      )
      .default([])
      .describe("Your verdict on every blocking finding still open from the previous review round."),
    acCoverage: z
      .array(
        z
          .object({ ac: AcId, verdict: CoverageVerdict, note: Text.optional() })
          .strict(),
      )
      .describe("One entry per acceptance criterion."),
    followUps: z
      .array(z.object({ text: Text, category: FindingCategory.optional() }).strict())
      .default([])
      .describe("Non-blocking ideas for later (refactors, extensions). They go to the backlog, not to the coder."),
  })
  .strict();
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;

// ---------------------------------------------------------------- coder

export const FileChange = z.enum(["added", "modified", "deleted", "renamed"]);
export type FileChange = z.infer<typeof FileChange>;

export const CoderOutput = z
  .object({
    ...common,
    filesChanged: z
      .array(
        z
          .object({ path: FilePath, change: FileChange, why: Text })
          .strict(),
      )
      .min(1),
    decisions: z
      .array(z.object({ decision: Text, rationale: Text, alternatives: z.array(Text).default([]) }).strict())
      .default([]),
    deviationsFromPlan: z.array(z.object({ what: Text, why: Text }).strict()).default([]),
    ...addressed,
    testDisputes: z
      .array(z.object({ testId: TestId, reason: Text }).strict())
      .default([])
      .describe("Protected tests you believe are wrong. Any dispute blocks the task for a human decision."),
    testsAdded: z
      .array(z.object({ file: FilePath, title: Text, covers: z.array(AcId).default([]) }).strict())
      .default([]),
    untestedCriteria: z.array(UntestedCriterion).default([]),
    docsUpdated: z.array(z.object({ path: FilePath, what: Text }).strict()).default([]),
  })
  .strict();
export type CoderOutput = z.infer<typeof CoderOutput>;

// ---------------------------------------------------------------- orchestrator inputs

export const PlanInput = z
  .object({
    title: Text.optional(),
    mode: Mode,
    summary: Text,
    acceptanceCriteria: z
      .array(Text)
      .min(1)
      .describe("Testable statements, in order. The CLI numbers them AC-1, AC-2, …"),
    contract: z
      .string()
      .default("")
      .describe("Markdown: modules, function signatures, endpoints, error shapes. Required in tdd mode — tests are written against it."),
    approach: z.array(Text).min(1).describe("Implementation steps."),
    testStrategy: z.string().default(""),
    relevantDocs: z.array(z.object({ path: FilePath, why: Text }).strict()).default([]),
    outOfScope: z.array(Text).default([]),
    risks: z.array(Text).default([]),
  })
  .strict();
export type PlanInput = z.infer<typeof PlanInput>;

/** Whether one document was updated for the change, didn't need to be, or still misses the update. */
export const DocStatus = z.enum(["updated", "not_needed", "missing"]);
export type DocStatus = z.infer<typeof DocStatus>;

export const DocsVerdict = z.enum(["ok", "needs_changes"]);
export type DocsVerdict = z.infer<typeof DocsVerdict>;

export const DocsCheckBase = z
  .object({
    items: z
      .array(
        z
          .object({ path: FilePath, status: DocStatus, note: Text })
          .strict(),
      )
      .min(1),
    verdict: DocsVerdict,
    notes: z.string().optional(),
  })
  .strict();

export const DocsCheckInput = DocsCheckBase.superRefine((d, ctx) => {
    const missing = d.items.some((i) => i.status === DocStatus.enum.missing);
    if (missing !== (d.verdict === DocsVerdict.enum.needs_changes)) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: 'verdict must be "needs_changes" exactly when some item has status "missing"',
      });
    }
  });
export type DocsCheckInput = z.infer<typeof DocsCheckInput>;

export const RetroInput = z
  .object({
    wentWell: z.array(Text).default([]),
    wentWrong: z.array(Text).default([]),
    processImprovements: z.array(Text).default([]),
    notes: z.string().optional(),
  })
  .strict();
export type RetroInput = z.infer<typeof RetroInput>;

// ---------------------------------------------------------------- product owner (refinement)

/** 1-based position of an item in the proposal's `items` list. */
const ItemPosition = z.number().int().min(1);

export const RefineItemInput = z
  .object({
    title: Text.max(80).describe("Short: what works after this item."),
    goal: Text.describe("Observable result for the user or the system, 1–3 sentences."),
    scope: z.array(Text).min(1).describe("What this item includes."),
    acceptanceCriteria: z
      .array(Text)
      .min(1)
      .describe("Draft criteria; the scrum-master refines them when the task is planned."),
    dependsOn: z.array(ItemPosition).default([]).describe("1-based positions of EARLIER items this one needs."),
    suggestedMode: Mode,
    modeReason: Text,
    touches: z.array(Text).default([]).describe("Modules, files or areas likely affected (from reading the repo)."),
    risks: z.array(Text).default([]),
    prerequisiteFor: Text.optional().describe(
      "Only for a technical step no requirement asks for directly (e.g. adding a test database or a library): why the later items need it. A later item must list this one in dependsOn.",
    ),
  })
  .strict();
export type RefineItemInput = z.infer<typeof RefineItemInput>;

export const RefineOutput = z
  .object({
    summary: Text.max(4000).describe("How you understood the slice and why you split it this way."),
    items: z.array(RefineItemInput).min(1).describe("In delivery order. The CLI numbers them I-1, I-2, …"),
    coverage: z
      .array(
        z
          .object({
            requirement: Text.describe("A requirement from the slice text, quoted or closely paraphrased."),
            items: z.array(ItemPosition).min(1).describe("1-based positions of the items that deliver it."),
          })
          .strict(),
      )
      .min(1),
    outOfScope: z.array(Text).default([]).describe("Parts of the slice text no item covers, and why."),
    openQuestions: z.array(Text).default([]),
    addressedNotes: z.array(z.object({ noteId: NoteId, note: Text }).strict()).default([]),
    processNotes: z.array(Text).default([]),
  })
  .strict();
export type RefineOutput = z.infer<typeof RefineOutput>;

export const INPUT_SCHEMAS = {
  tester: TesterOutput,
  reviewer: ReviewerOutput,
  coder: CoderOutput,
  plan: PlanInput,
  docs: DocsCheckInput,
  retro: RetroInput,
  refine: RefineOutput,
} as const;
export type InputSchemaName = keyof typeof INPUT_SCHEMAS;
