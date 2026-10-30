// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure step-graph operations behind the sequence canvas (desktop parity rows
// automation-63/64/65/67/68/71). Every expectation is written out by hand from
// the server contract (services/voice/internal/handlers/sequence_validation.go,
// generation/variants.go) — never derived from the functions under test.

import { describe, expect, it } from "vitest";

import { ApiError, OfflineQueuedError } from "@/lib/api";
import {
  addVariantDraft,
  appendStep,
  bpToPct,
  canvasStepsOf,
  classifySaveFailure,
  commitCanvasEdit,
  countSteps,
  describeAddress,
  draftsToVariants,
  dropTargetIndex,
  emailPositionNear,
  evenWeightsBp,
  findBlockingStep,
  followEmailPosition,
  insertStep,
  insertionProblem,
  moveStep,
  newStep,
  parseStepDragPayload,
  pctToBp,
  reconcileSelectedPosition,
  removeStep,
  removeVariantDraft,
  replaceStep,
  seedVariantDrafts,
  setEmailVariants,
  stepSummary,
  variantDraftsProblem,
  variantsProblem,
} from "@/lib/flow-canvas-model";
import type {
  Sequence,
  SequenceEmail,
  SequenceStoredStep,
} from "@/lib/voice-types";

const email = (position: number, subject: string): SequenceStoredStep => ({
  type: "email",
  position,
  email: { subject, body: `${subject} body` },
});

function tree(): SequenceStoredStep[] {
  return [
    email(1, "Hello"),
    {
      type: "delay",
      position: 2,
      delay: { seconds: 86400, value: 1, unit: "days" },
    },
    {
      type: "condition",
      position: 3,
      condition: {
        predicate: "opened_previous",
        yes_branch: [{ type: "tag_add", position: 1, tag: { tag: "engaged" } }],
        no_branch: [],
      },
    },
    email(4, "Follow up"),
  ];
}

function seqEmail(
  position: number,
  subject: string,
  fidelity: number,
): SequenceEmail {
  return {
    id: `seq_1-${position}`,
    position,
    subject,
    bodyMarkdown: `${subject} body`,
    bodyHtml: "",
    bodyMjml: null,
    delayHours: position === 1 ? 0 : 24,
    fidelity,
    fidelityBreakdown: {
      embedding: 90,
      stylistic: 80,
      vocab: 70,
      structural: 60,
    },
    fidelityBreakdownPresent: true,
    regenerationCount: 2,
  };
}

function legacySequence(): Sequence {
  return {
    id: "seq_1",
    version: 3,
    name: "Legacy",
    templateId: "welcome",
    templateName: "welcome",
    status: "draft",
    fidelityAvg: 85,
    emails: [seqEmail(1, "One", 91), seqEmail(2, "Two", 82)],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

describe("insertStep / appendStep", () => {
  it("inserts at a top-level gap, renumbers 1..n and maps origins", () => {
    const edit = insertStep(tree(), [], 1, newStep("exit"));
    expect(edit?.steps.map((s) => [s.type, s.position])).toEqual([
      ["email", 1],
      ["exit", 2],
      ["delay", 3],
      ["condition", 4],
      ["email", 5],
    ]);
    expect(edit?.origin).toEqual([0, null, 1, 2, 3]);
    expect(edit?.focus).toEqual({ slice: [], index: 1 });
    expect(edit?.announcement).toBe("Added Exit step at position 2 of 5.");
  });

  it("appends into a condition branch without touching the top level", () => {
    const before = tree();
    const edit = appendStep(
      before,
      [{ index: 2, branch: "yes" }],
      newStep("exit"),
    );
    const condition = edit?.steps[2];
    expect(condition?.type).toBe("condition");
    if (condition?.type !== "condition") throw new Error("unreachable");
    expect(condition.condition.yes_branch).toEqual([
      { type: "tag_add", position: 1, tag: { tag: "engaged" } },
      { type: "exit", position: 2 },
    ]);
    expect(condition.condition.no_branch).toEqual([]);
    expect(edit?.origin).toEqual([0, 1, 2, 3]);
    expect(edit?.announcement).toBe(
      "Added Exit step at position 2 of 2 in the Yes branch of step 3.",
    );
    // The input tree is not mutated.
    expect(before[2]).toEqual(tree()[2]);
  });

  it("refuses branches nested past depth 3 and trees at 100 steps", () => {
    const deep: SequenceStoredStep[] = [
      {
        type: "condition",
        position: 1,
        condition: {
          predicate: "clicked_any",
          yes_branch: [
            {
              type: "condition",
              position: 1,
              condition: {
                predicate: "clicked_any",
                yes_branch: [
                  {
                    type: "condition",
                    position: 1,
                    condition: {
                      predicate: "clicked_any",
                      yes_branch: [],
                      no_branch: [],
                    },
                  },
                ],
                no_branch: [],
              },
            },
          ],
          no_branch: [],
        },
      },
    ];
    const depth3: [
      { index: number; branch: "yes" },
      { index: number; branch: "yes" },
    ] = [
      { index: 0, branch: "yes" },
      { index: 0, branch: "yes" },
    ];
    expect(insertionProblem(deep, depth3)).toBeNull();
    const depth4 = [...depth3, { index: 0, branch: "yes" as const }];
    expect(insertionProblem(deep, depth4)).toBe(
      "Branches nest at most 3 levels deep, so this branch cannot hold steps.",
    );
    expect(insertStep(deep, depth4, 0, newStep("exit"))).toBeNull();

    const hundred = Array.from({ length: 100 }, (_, i) =>
      email(i + 1, `E${i + 1}`),
    );
    expect(insertionProblem(hundred, [])).toBe(
      "A sequence holds at most 100 steps.",
    );
    expect(insertStep(hundred, [], 0, newStep("exit"))).toBeNull();
  });
});

describe("moveStep / dropTargetIndex", () => {
  it("reorders within the top level and reports the permutation", () => {
    const edit = moveStep(tree(), { slice: [], index: 3 }, 1);
    expect(edit?.steps.map((s) => [s.type, s.position])).toEqual([
      ["email", 1],
      ["email", 2],
      ["delay", 3],
      ["condition", 4],
    ]);
    expect(edit?.origin).toEqual([0, 3, 1, 2]);
    expect(edit?.announcement).toBe("Moved Email step to position 2 of 4.");
  });

  it("reorders inside a branch and leaves the top-level identity", () => {
    const base = appendStep(
      tree(),
      [{ index: 2, branch: "yes" }],
      newStep("exit"),
    )!.steps;
    const edit = moveStep(
      base,
      { slice: [{ index: 2, branch: "yes" }], index: 1 },
      0,
    );
    const condition = edit?.steps[2];
    if (condition?.type !== "condition") throw new Error("expected condition");
    expect(condition.condition.yes_branch).toEqual([
      { type: "exit", position: 1 },
      { type: "tag_add", position: 2, tag: { tag: "engaged" } },
    ]);
    expect(edit?.origin).toEqual([0, 1, 2, 3]);
  });

  it("returns null for a no-op or out-of-range move", () => {
    expect(moveStep(tree(), { slice: [], index: 0 }, 0)).toBeNull();
    expect(moveStep(tree(), { slice: [], index: 0 }, -1)).toBeNull();
    expect(moveStep(tree(), { slice: [], index: 3 }, 4)).toBeNull();
  });

  it("maps a drop gap to the move target", () => {
    // Dragging index 0 to the gap before index 2 lands it at index 1.
    expect(dropTargetIndex(0, 2, 4)).toBe(1);
    // The end gap of a 4-step list moves index 1 to index 3.
    expect(dropTargetIndex(1, 4, 4)).toBe(3);
    expect(dropTargetIndex(3, 0, 4)).toBe(0);
    // Its own gap and the gap right after it do not move anything.
    expect(dropTargetIndex(2, 2, 4)).toBeNull();
    expect(dropTargetIndex(2, 3, 4)).toBeNull();
    expect(dropTargetIndex(0, 5, 4)).toBeNull();
  });
});

describe("removeStep / replaceStep / setEmailVariants", () => {
  it("removes a step, renumbers and never empties the top level", () => {
    const edit = removeStep(tree(), { slice: [], index: 1 });
    expect(edit?.steps.map((s) => [s.type, s.position])).toEqual([
      ["email", 1],
      ["condition", 2],
      ["email", 3],
    ]);
    expect(edit?.origin).toEqual([0, 2, 3]);
    expect(removeStep([email(1, "Only")], { slice: [], index: 0 })).toBeNull();
    // A branch may be emptied.
    const branch = removeStep(tree(), {
      slice: [{ index: 2, branch: "yes" }],
      index: 0,
    });
    const condition = branch?.steps[2];
    if (condition?.type !== "condition") throw new Error("expected condition");
    expect(condition.condition.yes_branch).toEqual([]);
  });

  it("replaces a step in place and refuses a type change", () => {
    const edit = replaceStep(
      tree(),
      { slice: [], index: 1 },
      {
        type: "delay",
        position: 99,
        delay: { seconds: 10800, value: 3, unit: "hours" },
      },
    );
    expect(edit?.steps[1]).toEqual({
      type: "delay",
      position: 2,
      delay: { seconds: 10800, value: 3, unit: "hours" },
    });
    expect(
      replaceStep(tree(), { slice: [], index: 1 }, newStep("exit")),
    ).toBeNull();
  });

  it("sets and clears an email step's variants (clearing omits the key)", () => {
    const variants = [
      { key: "A", subject: "Hello", body: "a", weight_bp: 5000 },
      { key: "B", subject: "Hi", body: "b", weight_bp: 5000 },
    ];
    const set = setEmailVariants(tree(), { slice: [], index: 0 }, variants);
    expect(set?.steps[0]).toEqual({
      type: "email",
      position: 1,
      email: { subject: "Hello", body: "Hello body", variants },
    });
    const cleared = setEmailVariants(
      set!.steps,
      { slice: [], index: 0 },
      undefined,
    );
    expect(cleared?.steps[0]).toEqual({
      type: "email",
      position: 1,
      email: { subject: "Hello", body: "Hello body" },
    });
    expect("variants" in (cleared!.steps[0] as { email: object }).email).toBe(
      false,
    );
    expect(
      setEmailVariants(tree(), { slice: [], index: 1 }, variants),
    ).toBeNull();
  });
});

describe("findBlockingStep mirrors the server's per-step validation", () => {
  it("accepts a complete tree", () => {
    expect(findBlockingStep(tree())).toBeNull();
  });

  it("names the first incomplete step with its location", () => {
    expect(findBlockingStep([...tree(), newStep("email")])?.message).toBe(
      "Step 5 (Email) needs a subject.",
    );
    const nested = appendStep(
      tree(),
      [{ index: 2, branch: "no" }],
      newStep("tag_remove"),
    )!;
    expect(findBlockingStep(nested.steps)?.message).toBe(
      "Step 3 › No › step 1 (Remove tag) needs a tag.",
    );
    expect(
      findBlockingStep([
        {
          type: "email",
          position: 1,
          email: { subject: "Only subject", body: "  " },
        },
      ])?.message,
    ).toBe("Step 1 (Email) needs a body.");
    expect(
      findBlockingStep([{ type: "delay", position: 1, delay: { seconds: 0 } }])
        ?.message,
    ).toBe("Step 1 (Delay) needs a wait between 1 minute and 365 days.");
    expect(
      findBlockingStep([
        {
          type: "condition",
          position: 1,
          condition: {
            predicate: "tag_present",
            yes_branch: [],
            no_branch: [],
          },
        },
      ])?.message,
    ).toBe("Step 1 (Condition) needs a condition value.");
    expect(
      findBlockingStep([
        {
          type: "email",
          position: 1,
          email: { subject: "Two\nlines", body: "b" },
        },
      ])?.message,
    ).toBe("Step 1 (Email) needs a subject on a single line.");
  });

  it("rejects a malformed stored A/B split", () => {
    expect(
      variantsProblem([
        { key: "A", subject: "a", body: "a", weight_bp: 6000 },
        { key: "B", subject: "b", body: "b", weight_bp: 3000 },
      ]),
    ).toBe("has A/B variant weights that do not total 100%");
    expect(
      variantsProblem([
        { key: "A", subject: "a", body: "a", weight_bp: 10000 },
      ]),
    ).toBe("needs between 2 and 4 A/B variants");
    expect(variantsProblem(undefined)).toBeNull();
  });
});

describe("A/B variant drafts", () => {
  it("splits weights exactly and converts percent strings", () => {
    expect(evenWeightsBp(3)).toEqual([3334, 3333, 3333]);
    expect(evenWeightsBp(4)).toEqual([2500, 2500, 2500, 2500]);
    expect(bpToPct(3334)).toBe("33.34");
    expect(bpToPct(5000)).toBe("50");
    expect(bpToPct(2550)).toBe("25.5");
    expect(pctToBp("33.34")).toBe(3334);
    expect(pctToBp(" ")).toBeNull();
    expect(pctToBp("ten")).toBeNull();
  });

  it("seeds two arms, caps at four, floors at two, relabels and re-evens", () => {
    const seeded = seedVariantDrafts({ subject: "Hello", body: "Body" });
    expect(seeded).toEqual([
      { key: "A", subject: "Hello", body: "Body", weight_pct: "50" },
      { key: "B", subject: "Hello", body: "Body", weight_pct: "50" },
    ]);
    const three = addVariantDraft(seeded);
    expect(three.map((d) => [d.key, d.weight_pct])).toEqual([
      ["A", "33.34"],
      ["B", "33.33"],
      ["C", "33.33"],
    ]);
    const four = addVariantDraft(three);
    expect(addVariantDraft(four)).toBe(four);
    const removed = removeVariantDraft(four, 0);
    expect(removed.map((d) => [d.key, d.weight_pct])).toEqual([
      ["A", "33.34"],
      ["B", "33.33"],
      ["C", "33.33"],
    ]);
    expect(removeVariantDraft(seeded, 0)).toBe(seeded);
  });

  it("validates drafts like generation.ValidateVariants and emits the wire shape", () => {
    const seeded = seedVariantDrafts({ subject: "Hello", body: "Body" });
    expect(variantDraftsProblem(seeded)).toBeNull();
    expect(draftsToVariants(seeded)).toEqual([
      { key: "A", subject: "Hello", body: "Body", weight_bp: 5000 },
      { key: "B", subject: "Hello", body: "Body", weight_bp: 5000 },
    ]);
    const skewed = [seeded[0], { ...seeded[1], weight_pct: "40" }];
    expect(variantDraftsProblem(skewed)).toBe(
      "Variant weights must total 100% (currently 90%).",
    );
    expect(draftsToVariants(skewed)).toBeNull();
    expect(
      variantDraftsProblem([seeded[0], { ...seeded[1], subject: " " }]),
    ).toBe("Variant B needs a subject.");
    expect(variantDraftsProblem([seeded[0], { ...seeded[1], body: "" }])).toBe(
      "Variant B needs a body.",
    );
    expect(variantDraftsProblem([seeded[0]])).toBe(
      "An A/B test needs at least 2 variants.",
    );
  });
});

describe("drag payloads", () => {
  it("parses only well-formed payloads", () => {
    expect(parseStepDragPayload('{"source":"palette","kind":"delay"}')).toEqual(
      {
        source: "palette",
        kind: "delay",
      },
    );
    expect(
      parseStepDragPayload(
        '{"source":"canvas-step","slice":[{"index":2,"branch":"yes"}],"index":1}',
      ),
    ).toEqual({
      source: "canvas-step",
      slice: [{ index: 2, branch: "yes" }],
      index: 1,
    });
    expect(
      parseStepDragPayload('{"source":"palette","kind":"sms"}'),
    ).toBeNull();
    expect(
      parseStepDragPayload(
        '{"source":"canvas-step","slice":[{"index":-1,"branch":"yes"}],"index":0}',
      ),
    ).toBeNull();
    expect(parseStepDragPayload("not json")).toBeNull();
    expect(parseStepDragPayload(`"${"x".repeat(3000)}"`)).toBeNull();
  });
});

describe("sequence bridging", () => {
  it("promotes a legacy emails-only row to email steps", () => {
    expect(canvasStepsOf(legacySequence())).toEqual([
      {
        type: "email",
        position: 1,
        email: {
          subject: "One",
          body: "One body",
          body_html: undefined,
          body_mjml: undefined,
          delay_seconds: 0,
        },
      },
      {
        type: "email",
        position: 2,
        email: {
          subject: "Two",
          body: "Two body",
          body_html: undefined,
          body_mjml: undefined,
          delay_seconds: 86400,
        },
      },
    ]);
  });

  it("merges edited top-level emails into a step graph and keeps variants", () => {
    const variants = [
      { key: "A", subject: "a", body: "a", weight_bp: 5000 },
      { key: "B", subject: "b", body: "b", weight_bp: 5000 },
    ];
    const seq: Sequence = {
      ...legacySequence(),
      steps: [
        {
          type: "email",
          position: 1,
          email: { subject: "Stored", body: "Stored body", variants },
        },
        { type: "exit", position: 2 },
      ],
      emails: [
        { ...seqEmail(1, "Edited subject", 0), bodyMarkdown: "Edited body" },
      ],
    };
    expect(canvasStepsOf(seq)[0]).toEqual({
      type: "email",
      position: 1,
      email: {
        subject: "Edited subject",
        body: "Edited body",
        body_html: undefined,
        body_mjml: undefined,
        delay_seconds: 0,
        variants,
      },
    });
  });

  it("keeps an emails-only reorder on the emails path with fidelity carried", () => {
    const seq = legacySequence();
    const previous = canvasStepsOf(seq);
    const edit = moveStep(previous, { slice: [], index: 1 }, 0)!;
    const commit = commitCanvasEdit(seq, previous, edit);
    expect(commit.convertsToGraph).toBe(false);
    expect(commit.sequence.steps).toBeUndefined();
    expect(
      commit.sequence.emails.map((e) => [
        e.position,
        e.subject,
        e.fidelity,
        e.delayHours,
        e.id,
      ]),
    ).toEqual([
      [1, "Two", 82, 24, "seq_1-1"],
      [2, "One", 91, 0, "seq_1-2"],
    ]);
    expect(commit.sequence.emails[0].regenerationCount).toBe(2);
    expect(followEmailPosition(previous, edit, 1)).toBe(2);
  });

  it("flags the emails-only → step-graph conversion a non-email step causes", () => {
    const seq = legacySequence();
    const previous = canvasStepsOf(seq);
    const edit = insertStep(previous, [], 1, newStep("delay"))!;
    const commit = commitCanvasEdit(seq, previous, edit);
    expect(commit.convertsToGraph).toBe(true);
    expect(commit.sequence.steps?.map((s) => [s.type, s.position])).toEqual([
      ["email", 1],
      ["delay", 2],
      ["email", 3],
    ]);
    expect(
      commit.sequence.emails.map((e) => [e.position, e.subject, e.fidelity]),
    ).toEqual([
      [1, "One", 91],
      [3, "Two", 82],
    ]);
  });

  it("keeps a step-graph row on the steps path even when only emails remain", () => {
    const seq: Sequence = {
      ...legacySequence(),
      steps: [email(1, "One"), { type: "exit", position: 2 }],
      emails: [seqEmail(1, "One", 0)],
    };
    const previous = canvasStepsOf(seq);
    const edit = removeStep(previous, { slice: [], index: 1 })!;
    const commit = commitCanvasEdit(seq, previous, edit);
    expect(commit.convertsToGraph).toBe(false);
    expect(commit.sequence.steps).toEqual([
      {
        type: "email",
        position: 1,
        email: {
          subject: "One",
          body: "One body",
          body_html: undefined,
          body_mjml: undefined,
          delay_seconds: 0,
        },
      },
    ]);
  });

  it("finds the nearest email after the selected one disappears", () => {
    const steps = tree();
    expect(emailPositionNear(steps, 1)).toBe(4);
    expect(emailPositionNear(steps.slice(0, 3), 2)).toBe(1);
    expect(emailPositionNear([{ type: "exit", position: 1 }], 0)).toBeNull();
  });
});

describe("save failure classification + 412 reconciliation", () => {
  it("names each failure by its remedy and keeps the server's sentence", () => {
    expect(
      classifySaveFailure(
        new ApiError("version mismatch — reload and retry", 412),
      ),
    ).toEqual({
      kind: "reload",
      message: "version mismatch — reload and retry",
    });
    expect(
      classifySaveFailure(
        new ApiError("only draft sequences are editable", 409),
      ).kind,
    ).toBe("reload");
    expect(
      classifySaveFailure(new ApiError("Service unavailable", 503)).kind,
    ).toBe("retry");
    expect(
      classifySaveFailure(new ApiError("You appear to be offline", 0)).kind,
    ).toBe("retry");
    expect(
      classifySaveFailure(new ApiError("Too many requests", 429)).kind,
    ).toBe("retry");
    expect(
      classifySaveFailure(new ApiError("step 1: email subject required", 400)),
    ).toEqual({
      kind: "fix",
      message: "step 1: email subject required",
    });
    expect(
      classifySaveFailure(
        new OfflineQueuedError(
          {} as ConstructorParameters<typeof OfflineQueuedError>[0],
        ),
      ).kind,
    ).toBe("queued");
    expect(
      classifySaveFailure(
        new Error("The server did not confirm the next sequence version."),
      ),
    ).toEqual({
      kind: "reload",
      message: "The server did not confirm the next sequence version.",
    });
  });

  it("keeps the selected email across a reload when it still exists", () => {
    const latest = legacySequence();
    expect(reconcileSelectedPosition(latest, 2)).toBe(2);
    expect(reconcileSelectedPosition(latest, 7)).toBe(1);
    expect(reconcileSelectedPosition({ emails: [] }, 3)).toBe(1);
  });
});

describe("labels", () => {
  it("describes addresses and steps the way the canvas names them", () => {
    expect(describeAddress({ slice: [], index: 2 })).toBe("Step 3");
    expect(
      describeAddress({ slice: [{ index: 1, branch: "no" }], index: 0 }),
    ).toBe("Step 2 › No › step 1");
    expect(stepSummary(tree()[1])).toBe("Wait 1 day");
    expect(
      stepSummary({ type: "delay", position: 1, delay: { seconds: 7200 } }),
    ).toBe("Wait 2 hours");
    expect(stepSummary(tree()[2])).toBe("If opened previous email");
    expect(countSteps(tree())).toBe(5);
  });
});
