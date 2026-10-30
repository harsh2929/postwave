// Tests for the canvas persist gate + culprit finder
// (components/sequence/step-persist.ts). The server validates the WHOLE
// steps[] array on every PATCH, so one malformed step blocks all saves;
// the canvas refuses to PATCH and must surface WHICH step is to blame
// (especially a legacy email whose A/B split doesn't sum to 100%, which
// the user may never have touched).

import { describe, expect, it } from "vitest";

import type { SequenceEmailVariant } from "../../lib/api-client";
import type { CanvasStep } from "../../components/sequence/types";
import {
  canPersistStep,
  canPersistSteps,
  findUnpersistableStep,
  persistBlockReason,
  stepDisplayName,
} from "../../components/sequence/step-persist";

let idSeq = 0;
function step(overrides: Partial<CanvasStep> & { type: CanvasStep["type"] }): CanvasStep {
  return { id: `s${idSeq++}`, position: 1, ...overrides };
}

function email(overrides: Partial<CanvasStep> = {}): CanvasStep {
  return step({ type: "email", subject: "Welcome", body: "Hi", ...overrides });
}

/** A valid 2-arm split (sums to 100%). */
const validVariants: SequenceEmailVariant[] = [
  { key: "A", subject: "S", body: "B", weight_bp: 5000 },
  { key: "B", subject: "S", body: "B", weight_bp: 5000 },
];

/** A split whose weights DON'T sum to 100% (server would 400). */
const badSumVariants: SequenceEmailVariant[] = [
  { key: "A", subject: "S", body: "B", weight_bp: 6000 },
  { key: "B", subject: "S", body: "B", weight_bp: 5000 },
];

/* ---------------------------------------------------------------- */
/* canPersistStep / canPersistSteps                                  */
/* ---------------------------------------------------------------- */

describe("canPersistStep", () => {
  it("accepts a plain email with a subject and no variants", () => {
    expect(canPersistStep(email())).toBe(true);
  });

  it("accepts an email with a valid A/B split", () => {
    expect(canPersistStep(email({ variants: validVariants }))).toBe(true);
  });

  it("rejects an email with no subject", () => {
    expect(canPersistStep(email({ subject: "  " }))).toBe(false);
  });

  it("rejects an email whose variant weights don't sum to 100%", () => {
    expect(canPersistStep(email({ variants: badSumVariants }))).toBe(false);
  });

  it("gates delay / tag / condition steps", () => {
    expect(canPersistStep(step({ type: "delay", delay_value: 0 }))).toBe(false);
    expect(canPersistStep(step({ type: "delay", delay_value: 2 }))).toBe(true);
    expect(canPersistStep(step({ type: "tag_add", tag: "" }))).toBe(false);
    expect(canPersistStep(step({ type: "tag_add", tag: "vip" }))).toBe(true);
    expect(canPersistStep(step({ type: "exit" }))).toBe(true);
  });

  it("recurses into condition branches", () => {
    const cond = step({
      type: "condition",
      condition_type: "opened",
      yes_branch: [email({ subject: "" })],
      no_branch: [],
    });
    expect(canPersistStep(cond)).toBe(false);
  });
});

describe("canPersistSteps", () => {
  it("is true only when every step persists", () => {
    expect(canPersistSteps([email(), step({ type: "exit" })])).toBe(true);
    expect(
      canPersistSteps([email(), email({ variants: badSumVariants })]),
    ).toBe(false);
  });
});

/* ---------------------------------------------------------------- */
/* findUnpersistableStep — the culprit finder                        */
/* ---------------------------------------------------------------- */

describe("findUnpersistableStep", () => {
  it("returns null when every step is persistable", () => {
    expect(findUnpersistableStep([email(), step({ type: "exit" })])).toBeNull();
  });

  it("finds the offending top-level step", () => {
    const bad = email({ subject: "Sale", variants: badSumVariants });
    const found = findUnpersistableStep([email(), bad, step({ type: "exit" })]);
    expect(found?.id).toBe(bad.id);
  });

  it("returns the FIRST offender in document order", () => {
    const first = step({ type: "tag_add", tag: "" });
    const second = email({ variants: badSumVariants });
    expect(findUnpersistableStep([email(), first, second])?.id).toBe(first.id);
  });

  it("descends into condition branches to find a buried culprit", () => {
    const buried = email({ subject: "Inner", variants: badSumVariants });
    const cond = step({
      type: "condition",
      condition_type: "opened",
      yes_branch: [email(), buried],
      no_branch: [],
    });
    expect(findUnpersistableStep([email(), cond])?.id).toBe(buried.id);
  });

  it("reports a condition missing its type rather than recursing past it", () => {
    const cond = step({
      type: "condition",
      condition_type: undefined,
      yes_branch: [],
      no_branch: [],
    });
    expect(findUnpersistableStep([cond])?.id).toBe(cond.id);
  });
});

/* ---------------------------------------------------------------- */
/* operator-facing copy                                              */
/* ---------------------------------------------------------------- */

describe("stepDisplayName", () => {
  it("prefers the email subject in quotes", () => {
    expect(stepDisplayName(email({ subject: "Sale" }))).toBe('"Sale"');
  });

  it("falls back to the type label for non-emails or blank subjects", () => {
    expect(stepDisplayName(email({ subject: "  " }))).toBe("The email step");
    expect(stepDisplayName(step({ type: "delay", delay_value: 1 }))).toBe(
      "The delay step",
    );
    expect(stepDisplayName(step({ type: "tag_add", tag: "x" }))).toBe(
      "The add tag step",
    );
  });
});

describe("persistBlockReason", () => {
  it("returns null for a step that can persist", () => {
    expect(persistBlockReason(email())).toBeNull();
  });

  it("calls out the variant-sum case specifically, naming the step", () => {
    const reason = persistBlockReason(
      email({ subject: "Spring sale", variants: badSumVariants }),
    );
    expect(reason).toBe(
      `"Spring sale" has variant weights that don't sum to 100% — fix it before saving.`,
    );
  });

  it("explains a missing subject", () => {
    expect(persistBlockReason(email({ subject: "" }))).toBe(
      "The email step needs a subject before it can be saved.",
    );
  });

  it("explains delay / tag / condition blockers", () => {
    expect(persistBlockReason(step({ type: "delay", delay_value: 0 }))).toMatch(
      /wait longer than zero/,
    );
    expect(persistBlockReason(step({ type: "tag_remove", tag: "" }))).toMatch(
      /needs a tag name/,
    );
    expect(
      persistBlockReason(
        step({ type: "condition", condition_type: undefined }),
      ),
    ).toMatch(/missing its condition/);
  });
});
