/**
 * The comparison that decides whether a sequence canvas edit is worth a PATCH.
 *
 * The cases below are the ones the canvas actually produces — they are driven
 * through the REAL serializer (`canvasToWire`) rather than hand-written wire
 * literals, because the whole point is "would the server see a difference",
 * and only the serializer knows what the server sees.
 */
import { describe, expect, it } from "vitest";

import {
  canvasToWire,
  type CanvasStep,
} from "@/components/sequence-builder/types";
import {
  sequenceSaveIsWorthSending,
  sequenceWireStepsEqual,
  wireValueEqual,
} from "./sequenceWireDiff";

function email(id: string, subject: string, body = "Hello"): CanvasStep {
  return { id, type: "email", position: 0, subject, body };
}

function delay(id: string, value: number): CanvasStep {
  return {
    id,
    type: "delay",
    position: 0,
    delay_value: value,
    delay_unit: "days",
  };
}

/** What `applyAndSave` does before handing the list to the save path. */
function reindexed(steps: CanvasStep[]): CanvasStep[] {
  return steps.map((s, i) => ({ ...s, position: i }));
}

describe("wireValueEqual", () => {
  it("treats an undefined-valued key as absent, because JSON.stringify does", () => {
    expect(wireValueEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(wireValueEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
  });

  it("does not treat null as absent — null is a value the server stores", () => {
    expect(wireValueEqual({ a: null }, {})).toBe(false);
    expect(wireValueEqual({ a: null }, { a: undefined })).toBe(false);
  });

  it("ignores key order but not array order", () => {
    expect(wireValueEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(wireValueEqual([1, 2], [2, 1])).toBe(false);
  });

  it("separates same-shaped primitives of different type", () => {
    expect(wireValueEqual(1, "1")).toBe(false);
    expect(wireValueEqual(0, false)).toBe(false);
    expect(wireValueEqual([], {})).toBe(false);
  });

  it("recurses into nested condition branches", () => {
    const left = { condition: { yes_branch: [{ type: "exit", position: 1 }] } };
    const right = { condition: { yes_branch: [{ type: "exit", position: 1 }] } };
    expect(wireValueEqual(left, right)).toBe(true);
    expect(
      wireValueEqual(left, {
        condition: { yes_branch: [{ type: "exit", position: 2 }] },
      }),
    ).toBe(false);
  });
});

describe("sequenceWireStepsEqual", () => {
  it("never conflates 'no list' with 'the empty list'", () => {
    // Absent `steps` means "leave the tree alone"; `[]` means "clear it".
    expect(sequenceWireStepsEqual(undefined, [])).toBe(false);
    expect(sequenceWireStepsEqual(null, [])).toBe(false);
    expect(sequenceWireStepsEqual(null, undefined)).toBe(true);
    expect(sequenceWireStepsEqual([], [])).toBe(true);
  });
});

describe("suppressing the saves the server would answer 400", () => {
  it("a boundary move produces an identical wire tree", () => {
    // `onMoveStep` returns the list untouched when the step is already first,
    // then `applyAndSave` re-indexes it. Nothing the server can see changed,
    // yet this used to enqueue a PATCH that 400s with
    // "patch does not change the sequence" and surfaces an error toast.
    const steps = [email("a", "One"), delay("b", 2), email("c", "Two")];
    const before = canvasToWire(steps);
    const after = canvasToWire(reindexed(steps));
    expect(sequenceSaveIsWorthSending(before, after)).toBe(false);
  });

  it("re-committing an unedited step from the editor sheet is a no-op", () => {
    const steps = [email("a", "One"), email("b", "Two")];
    const unchanged = steps.map((s) => (s.id === "b" ? { ...s } : s));
    expect(
      sequenceSaveIsWorthSending(canvasToWire(steps), canvasToWire(unchanged)),
    ).toBe(false);
  });

  it("client-only step ids are invisible to the comparison", () => {
    // `genStepId` values never reach the wire, so a remount that regenerates
    // them must not read as an edit.
    const a = [email("client-1", "One"), delay("client-2", 3)];
    const b = [email("client-99", "One"), delay("client-98", 3)];
    expect(
      sequenceSaveIsWorthSending(canvasToWire(a), canvasToWire(b)),
    ).toBe(false);
  });
});

describe("changes that must still be sent", () => {
  it("an actual reorder", () => {
    const steps = [email("a", "One"), email("b", "Two")];
    const swapped = reindexed([steps[1] as CanvasStep, steps[0] as CanvasStep]);
    expect(
      sequenceSaveIsWorthSending(canvasToWire(steps), canvasToWire(swapped)),
    ).toBe(true);
  });

  it("an edited subject", () => {
    const before = canvasToWire([email("a", "One")]);
    const after = canvasToWire([email("a", "One!")]);
    expect(sequenceSaveIsWorthSending(before, after)).toBe(true);
  });

  it("a deletion", () => {
    const before = canvasToWire([email("a", "One"), email("b", "Two")]);
    const after = canvasToWire(reindexed([email("a", "One")]));
    expect(sequenceSaveIsWorthSending(before, after)).toBe(true);
  });

  it("clearing the canvas entirely", () => {
    expect(
      sequenceSaveIsWorthSending(canvasToWire([email("a", "One")]), canvasToWire([])),
    ).toBe(true);
  });

  it("a desktop-authored field mobile never edits but must not drop", () => {
    // body_mjml survives `canvasToWire` (AUTOMATION#18). If it were dropped the
    // two trees would compare equal and a genuine change could be suppressed —
    // this pins the comparison to the serializer's real output.
    const before: CanvasStep[] = [
      { ...email("a", "One"), body_mjml: "<mjml>a</mjml>" },
    ];
    const after: CanvasStep[] = [
      { ...email("a", "One"), body_mjml: "<mjml>b</mjml>" },
    ];
    expect(
      sequenceSaveIsWorthSending(canvasToWire(before), canvasToWire(after)),
    ).toBe(true);
  });
});
