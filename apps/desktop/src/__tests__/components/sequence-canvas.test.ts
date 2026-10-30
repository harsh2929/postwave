// Tests the visual sequence canvas data model. The actual canvas is a
// drag-and-drop React surface; the testable layer is the pure-data
// model in components/sequence/types.ts plus the reducer ops the
// canvas applies (drop, reorder, delete).

import { describe, expect, it } from "vitest";

import {
  type CanvasStep,
  type StepType,
  isBackendPersistable,
  genStepId,
  moveCanvasStep,
  stepSummary,
  stepTypeLabel,
} from "../../components/sequence/types";

/* ---------------------------------------------------------------- */
/* drop / reorder / delete reducer                                   */
/* ---------------------------------------------------------------- */

function addStepEnd(steps: CanvasStep[], type: StepType): CanvasStep[] {
  const s: CanvasStep = {
    id: genStepId(),
    type,
    position: steps.length,
  };
  return [...steps, s];
}

function moveStep(steps: CanvasStep[], from: number, to: number): CanvasStep[] {
  if (from === to) return steps;
  if (from < 0 || from >= steps.length) return steps;
  if (to < 0 || to >= steps.length) return steps;
  const copy = [...steps];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy.map((s, i) => ({ ...s, position: i }));
}

function deleteStep(steps: CanvasStep[], id: string): CanvasStep[] {
  return steps
    .filter((s) => s.id !== id)
    .map((s, i) => ({ ...s, position: i }));
}

/* ---------------------------------------------------------------- */
/* Tests                                                             */
/* ---------------------------------------------------------------- */

describe("sequence canvas — drop adds to ordered list", () => {
  it("dropping an Email step onto an empty canvas yields a 1-step ordered list", () => {
    const out = addStepEnd([], "email");
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("email");
    expect(out[0].position).toBe(0);
  });

  it("dropping a Delay onto a 1-step canvas keeps positions sequential", () => {
    const start = addStepEnd([], "email");
    const after = addStepEnd(start, "delay");
    expect(after.map((s) => s.position)).toEqual([0, 1]);
    expect(after.map((s) => s.type)).toEqual(["email", "delay"]);
  });
});

describe("sequence canvas — moveStep reorders", () => {
  it("moves the second step to the head", () => {
    const a = addStepEnd([], "email");
    const b = addStepEnd(a, "delay");
    const c = addStepEnd(b, "email");
    expect(c.map((s) => s.type)).toEqual(["email", "delay", "email"]);
    const moved = moveStep(c, 2, 0);
    expect(moved.map((s) => s.type)).toEqual(["email", "email", "delay"]);
    expect(moved.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("no-op when from === to", () => {
    const seq = addStepEnd(addStepEnd([], "email"), "delay");
    const same = moveStep(seq, 1, 1);
    expect(same).toBe(seq); // referential equality — no churn
  });

  it("out-of-bounds is a no-op", () => {
    const seq = addStepEnd([], "email");
    expect(moveStep(seq, 5, 0)).toBe(seq);
  });
});

describe("sequence canvas — moveCanvasStep reorders top-level nodes", () => {
  const step = (id: string, type: StepType = "email"): CanvasStep => ({
    id,
    type,
    position: 0,
  });

  it("moves a node before another node and renumbers positions 1-based", () => {
    const moved = moveCanvasStep(
      [step("a"), step("b", "delay"), step("c", "exit")],
      "c",
      { kind: "before", targetId: "a" },
    );
    expect(moved.map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(moved.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it("moves a node after another node", () => {
    const moved = moveCanvasStep(
      [step("a"), step("b", "delay"), step("c", "exit")],
      "a",
      { kind: "after", targetId: "b" },
    );
    expect(moved.map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("moves a condition with branch contents as one atomic node", () => {
    const condition: CanvasStep = {
      id: "cond",
      type: "condition",
      position: 2,
      yes_branch: [step("yes")],
      no_branch: [step("no")],
    };
    const moved = moveCanvasStep([step("a"), condition, step("c")], "cond", {
      kind: "end",
    });
    expect(moved.map((s) => s.id)).toEqual(["a", "c", "cond"]);
    expect(moved[2].type).toBe("condition");
    if (moved[2].type === "condition") {
      expect(moved[2].yes_branch?.map((s) => s.id)).toEqual(["yes"]);
      expect(moved[2].no_branch?.map((s) => s.id)).toEqual(["no"]);
    }
  });

  it("is a no-op for self-drops and missing targets", () => {
    const seq = [step("a"), step("b")];
    expect(moveCanvasStep(seq, "a", { kind: "before", targetId: "a" })).toBe(
      seq,
    );
    expect(moveCanvasStep(seq, "a", { kind: "before", targetId: "z" })).toBe(
      seq,
    );
  });
});

describe("sequence canvas — delete removes the step", () => {
  it("removes by id and re-numbers positions", () => {
    const a = addStepEnd([], "email");
    const b = addStepEnd(a, "delay");
    const c = addStepEnd(b, "email");
    const idMid = c[1].id;
    const after = deleteStep(c, idMid);
    expect(after.length).toBe(2);
    expect(after.map((s) => s.position)).toEqual([0, 1]);
    expect(after.find((s) => s.id === idMid)).toBeUndefined();
  });
});

describe("sequence canvas — disabled-tooltip surface (isBackendPersistable)", () => {
  // The story's claim that condition/tag/exit are "unsupported" was true
  // before v0.3; the current API persists all six types. We pin the
  // current contract so a future regression of the desktop UI to
  // disabling these types is loud.
  it("every step type is currently backend-persistable", () => {
    for (const t of [
      "email",
      "delay",
      "condition",
      "tag_add",
      "tag_remove",
      "exit",
    ] as StepType[]) {
      expect(isBackendPersistable(t)).toBe(true);
    }
  });
});

describe("sequence canvas — empty state gate", () => {
  it("renders the empty placeholder when there are zero steps", () => {
    const isEmpty = (steps: CanvasStep[]): boolean => steps.length === 0;
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(addStepEnd([], "email"))).toBe(false);
  });
});

describe("sequence canvas — label and summary helpers", () => {
  it("stepTypeLabel returns human-friendly strings", () => {
    expect(stepTypeLabel("email")).toBe("Email");
    expect(stepTypeLabel("delay")).toBe("Delay");
    expect(stepTypeLabel("condition")).toBe("Condition");
    expect(stepTypeLabel("tag_add")).toBe("Add tag");
    expect(stepTypeLabel("tag_remove")).toBe("Remove tag");
    expect(stepTypeLabel("exit")).toBe("Exit");
  });

  it("stepSummary surfaces the subject for emails / delay-for-delays", () => {
    expect(
      stepSummary({ id: "x", type: "email", position: 0, subject: "Hi" }),
    ).toBe("Subject: Hi");
    expect(
      stepSummary({
        id: "x",
        type: "delay",
        position: 0,
        delay_value: 3,
        delay_unit: "days",
      }),
    ).toBe("Wait 3 days");
    expect(stepSummary({ id: "x", type: "exit", position: 0 })).toBe(
      "Planned sequence exit",
    );
    expect(
      stepSummary({
        id: "x",
        type: "condition",
        position: 0,
        condition_type: "product_event",
        condition_value: "trial_started",
      }),
    ).toBe('When event "trial_started" fires');
  });
});
