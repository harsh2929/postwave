import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEQUENCE_NAME,
  MAX_SEQUENCE_DRAFT_STEPS,
  MAX_SEQUENCE_NAME_CHARS,
  MAX_SEQUENCE_SUBJECT_CHARS,
  MAX_STORED_DRAFT_BYTES,
  isPaletteStepKind,
  isStoredDraftTooLarge,
  newStep,
  restoreStoredDraft,
  restoreStoredDraftSteps,
  serializeSequenceDraft,
  stepSummary,
  stepTitle,
  toStoredSteps,
  validateSequenceName,
  validateSteps,
  type CanvasStep,
} from "../app/(dashboard)/app/sequences/new/_components/sequence-builder-helpers";

function step(patch: Partial<CanvasStep> = {}): CanvasStep {
  return {
    id: "email-1",
    type: "email",
    subject: "Hello",
    body: "Body",
    delayValue: 0,
    delayUnit: "hours",
    ...patch,
  } as CanvasStep;
}

describe("sequence builder helpers", () => {
  it("builds default steps and recognizes palette kinds", () => {
    expect(isPaletteStepKind("email")).toBe(true);
    expect(isPaletteStepKind("unknown")).toBe(false);
    expect(newStep("delay")).toMatchObject({
      type: "delay",
      value: 1,
      unit: "days",
    });
    expect(newStep("condition")).toMatchObject({
      type: "condition",
      predicate: "opened_previous",
      value: "",
    });
  });

  it("restores draft steps defensively from session storage JSON", () => {
    const restored = restoreStoredDraftSteps(
      JSON.stringify([
        { id: " bad-id ", type: "exit" },
        {
          id: "email-1",
          type: "email",
          subject: "Subject",
          body: "Body",
          delayValue: 2,
          delayUnit: "minutes",
        },
        {
          id: "condition-1",
          type: "condition",
          predicate: "missing_predicate",
          value: 123,
        },
        {
          id: "tag-1",
          type: "tag_add",
          tag: "x".repeat(600),
        },
      ]),
    );

    expect(restored).toEqual([
      {
        id: "email-1",
        type: "email",
        subject: "Subject",
        body: "Body",
        delayValue: 2,
        delayUnit: "minutes",
      },
      {
        id: "condition-1",
        type: "condition",
        predicate: "opened_previous",
        value: "",
      },
      {
        id: "tag-1",
        type: "tag_add",
        tag: "x".repeat(512),
      },
    ]);
    expect(restoreStoredDraftSteps("{bad json")).toBeNull();
    expect(isStoredDraftTooLarge("x".repeat(MAX_STORED_DRAFT_BYTES + 1))).toBe(
      true,
    );
    expect(
      restoreStoredDraftSteps("x".repeat(MAX_STORED_DRAFT_BYTES + 1)),
    ).toBeNull();
  });

  it("preserves recoverable legacy steps but blocks them above the server maximum", () => {
    const raw = JSON.stringify(
      Array.from({ length: MAX_SEQUENCE_DRAFT_STEPS + 5 }, (_, index) => ({
        id: `exit-${index}`,
        type: "exit",
      })),
    );

    const restored = restoreStoredDraftSteps(raw);
    expect(restored).toHaveLength(MAX_SEQUENCE_DRAFT_STEPS + 5);
    expect(validateSteps(restored ?? [])).toContain(
      `${MAX_SEQUENCE_DRAFT_STEPS} steps`,
    );
    expect(MAX_SEQUENCE_DRAFT_STEPS).toBe(100);
  });

  it("round-trips the complete draft and still accepts legacy step arrays", () => {
    const steps = [step({ subject: "Welcome", body: "Hello" })];
    const stored = serializeSequenceDraft("Lifecycle onboarding", steps);

    expect(restoreStoredDraft(stored)).toEqual({
      name: "Lifecycle onboarding",
      steps,
    });
    expect(restoreStoredDraft(JSON.stringify(steps))).toEqual({
      name: DEFAULT_SEQUENCE_NAME,
      steps,
    });
  });

  it("validates save-blocking sequence builder states", () => {
    expect(
      validateSequenceName("🙂".repeat(MAX_SEQUENCE_NAME_CHARS)),
    ).toBeNull();
    expect(validateSequenceName("🙂".repeat(MAX_SEQUENCE_NAME_CHARS + 1))).toBe(
      `Sequence name must be ${MAX_SEQUENCE_NAME_CHARS} characters or fewer.`,
    );
    expect(validateSteps([])).toBe("Add at least one step before saving.");
    expect(validateSteps([step({ subject: "  " })])).toBe(
      "Step 1: an email step needs a subject line.",
    );
    expect(
      validateSteps([
        step({ subject: "x".repeat(MAX_SEQUENCE_SUBJECT_CHARS + 1) }),
      ]),
    ).toBe(
      `Step 1: the subject must be ${MAX_SEQUENCE_SUBJECT_CHARS} characters or fewer.`,
    );
    expect(validateSteps([step({ body: " \n\t " })])).toBe(
      "Step 1: an email step needs a body.",
    );
    expect(
      validateSteps(
        Array.from({ length: MAX_SEQUENCE_DRAFT_STEPS + 1 }, (_, index) =>
          step({ id: `exit-${index}`, type: "exit" }),
        ),
      ),
    ).toContain(`${MAX_SEQUENCE_DRAFT_STEPS} steps`);
    expect(
      validateSteps([step({ type: "delay", value: 0, unit: "hours" })]),
    ).toBe("Step 1: wait time must be greater than zero.");
    expect(
      validateSteps([
        step({
          type: "condition",
          predicate: "tag_present",
          value: " ",
        }),
      ]),
    ).toBe("Step 1: this condition needs an argument.");
    expect(validateSteps([step({ type: "tag_remove", tag: "" })])).toBe(
      "Step 1: enter a tag before saving.",
    );
    expect(validateSteps([step({ type: "exit" })])).toBeNull();
    expect(
      validateSteps([
        step({
          subject: "🙂".repeat(MAX_SEQUENCE_SUBJECT_CHARS),
          body: "A legal body",
        }),
      ]),
    ).toBeNull();
  });

  it("maps canvas steps to backend sequence steps with stable positions", () => {
    expect(
      toStoredSteps([
        step({
          id: "email-1",
          type: "email",
          subject: " Hello ",
          body: "Body",
          delayValue: 1.5,
          delayUnit: "hours",
        }),
        step({ id: "delay-1", type: "delay", value: 2, unit: "days" }),
        step({
          id: "condition-1",
          type: "condition",
          predicate: "tag_present",
          value: " vip ",
        }),
        step({ id: "tag-1", type: "tag_remove", tag: " prospect " }),
        step({ id: "exit-1", type: "exit" }),
      ]),
    ).toEqual([
      {
        type: "email",
        position: 1,
        email: {
          subject: "Hello",
          body: "Body",
          delay_seconds: 5400,
        },
      },
      {
        type: "delay",
        position: 2,
        delay: {
          seconds: 172800,
          value: 2,
          unit: "days",
        },
      },
      {
        type: "condition",
        position: 3,
        condition: {
          predicate: "tag_present",
          value: "vip",
          yes_branch: [],
          no_branch: [],
        },
      },
      {
        type: "tag_remove",
        position: 4,
        tag: { tag: "prospect" },
      },
      { type: "exit", position: 5 },
    ]);
  });

  it("formats step titles and summaries used by the canvas list", () => {
    expect(stepTitle(step({ subject: "" }))).toBe("Untitled email");
    expect(stepSummary(step({ body: "A".repeat(120) }))).toHaveLength(90);
    expect(stepTitle(step({ type: "tag_add", tag: "vip" }))).toBe(
      "Add tag: vip",
    );
    expect(stepSummary(step({ type: "condition", value: "clicked" }))).toBe(
      "Argument: clicked",
    );
  });
});
