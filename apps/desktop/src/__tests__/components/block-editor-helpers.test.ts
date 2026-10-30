/**
 * block-editor-helpers — pure-logic coverage for the BlockEditor's
 * instance-list operations (full-surface wiring #1).
 *
 * Invariants under test:
 *   1. Every list op is immutable; out-of-range ops return the
 *      original reference (cheap no-op detection for button states).
 *   2. defaultConfigFor seeds every declared field so controlled
 *      inputs never see `undefined`.
 *   3. coerceFieldValue mirrors the Go composer's loose typing.
 */

import { describe, expect, it } from "vitest";

import type { EmailBlock } from "../../lib/api-client";
import {
  addInstance,
  buildComposeInput,
  coerceFieldValue,
  createInstance,
  defaultConfigFor,
  fieldValueAsString,
  groupBlocksByCategory,
  indexBlocks,
  instanceSummary,
  moveInstance,
  removeInstanceAt,
  setInstanceField,
} from "../../components/composer/block-editor-helpers";

const heroBlock: EmailBlock = {
  id: "hero_text",
  name: "Hero — text",
  category: "hero",
  description: "Large headline + supporting subhead.",
  fields: [
    { key: "headline", label: "Headline", type: "text" },
    { key: "subhead", label: "Subhead", type: "text" },
  ],
  defaults: { headline: "Welcome" },
};

const spacerBlock: EmailBlock = {
  id: "spacer",
  name: "Spacer",
  category: "layout",
  description: "Vertical whitespace.",
  fields: [
    { key: "height", label: "Height", type: "number" },
    { key: "visible", label: "Visible", type: "bool" },
    { key: "align", label: "Align", type: "select", options: ["left", "center"] },
  ],
  defaults: {},
};

describe("defaultConfigFor / createInstance", () => {
  it("merges server defaults and seeds missing fields by type", () => {
    const cfg = defaultConfigFor(heroBlock);
    expect(cfg.headline).toBe("Welcome"); // server default wins
    expect(cfg.subhead).toBe(""); // text seeds to ""
  });

  it("seeds bool=false and select=first option", () => {
    const cfg = defaultConfigFor(spacerBlock);
    expect(cfg.visible).toBe(false);
    expect(cfg.align).toBe("left");
    expect(cfg.height).toBe("");
  });

  it("preserves hidden defaults not declared as fields", () => {
    const block: EmailBlock = {
      ...heroBlock,
      defaults: { headline: "Hi", feed_id: "abc" },
    };
    expect(defaultConfigFor(block).feed_id).toBe("abc");
  });

  it("createInstance carries the block id", () => {
    expect(createInstance(heroBlock).block_id).toBe("hero_text");
  });
});

describe("list operations", () => {
  const list = [createInstance(heroBlock), createInstance(spacerBlock)];

  it("addInstance appends without mutating the input", () => {
    const next = addInstance(list, heroBlock);
    expect(next).toHaveLength(3);
    expect(list).toHaveLength(2);
    expect(next[2]!.block_id).toBe("hero_text");
  });

  it("removeInstanceAt drops the row; out-of-range is the same ref", () => {
    expect(removeInstanceAt(list, 0)).toHaveLength(1);
    expect(removeInstanceAt(list, 0)[0]!.block_id).toBe("spacer");
    expect(removeInstanceAt(list, 5)).toBe(list);
    expect(removeInstanceAt(list, -1)).toBe(list);
  });

  it("moveInstance swaps neighbours and clamps at the edges", () => {
    const down = moveInstance(list, 0, 1);
    expect(down.map((r) => r.block_id)).toEqual(["spacer", "hero_text"]);
    const up = moveInstance(down, 1, -1);
    expect(up.map((r) => r.block_id)).toEqual(["hero_text", "spacer"]);
    // Edge moves are no-ops returning the original reference.
    expect(moveInstance(list, 0, -1)).toBe(list);
    expect(moveInstance(list, 1, 1)).toBe(list);
    expect(moveInstance(list, 9, 1)).toBe(list);
  });

  it("setInstanceField updates one key immutably", () => {
    const next = setInstanceField(list, 0, "headline", "New");
    expect(next[0]!.config.headline).toBe("New");
    expect(list[0]!.config.headline).toBe("Welcome");
    // untouched row keeps its reference
    expect(next[1]).toBe(list[1]);
    // out-of-range no-op
    expect(setInstanceField(list, 7, "x", 1)).toBe(list);
  });
});

describe("coerceFieldValue / fieldValueAsString", () => {
  it("parses number fields strictly, keeping junk as-typed", () => {
    const spec = { key: "h", label: "H", type: "number" };
    expect(coerceFieldValue(spec, "42")).toBe(42);
    expect(coerceFieldValue(spec, "4.5")).toBe(4.5);
    expect(coerceFieldValue(spec, "")).toBe("");
    expect(coerceFieldValue(spec, "12px")).toBe("12px");
  });

  it("bools pass through; text stays text", () => {
    expect(coerceFieldValue({ key: "v", label: "V", type: "bool" }, true)).toBe(
      true,
    );
    expect(
      coerceFieldValue({ key: "v", label: "V", type: "bool" }, "true"),
    ).toBe(true);
    expect(coerceFieldValue({ key: "t", label: "T", type: "text" }, "42")).toBe(
      "42",
    );
  });

  it("fieldValueAsString round-trips primitives and blanks objects", () => {
    expect(fieldValueAsString("a")).toBe("a");
    expect(fieldValueAsString(42)).toBe("42");
    expect(fieldValueAsString(false)).toBe("false");
    expect(fieldValueAsString(null)).toBe("");
    expect(fieldValueAsString({ nested: true })).toBe("");
  });
});

describe("instanceSummary", () => {
  it("prefers the first non-empty text-ish field value", () => {
    const inst = setInstanceField([createInstance(heroBlock)], 0, "headline", "Hello world")[0]!;
    expect(instanceSummary(heroBlock, inst)).toBe("Hello world");
  });

  it("truncates long values to 60 chars with an ellipsis", () => {
    const long = "x".repeat(80);
    const inst = setInstanceField([createInstance(heroBlock)], 0, "headline", long)[0]!;
    const summary = instanceSummary(heroBlock, inst);
    expect(summary.length).toBe(58);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("falls back to description, then to the raw block id", () => {
    const inst = createInstance(spacerBlock);
    expect(instanceSummary(spacerBlock, inst)).toBe("Vertical whitespace.");
    expect(instanceSummary(undefined, inst)).toBe("spacer");
  });
});

describe("groupBlocksByCategory / indexBlocks / buildComposeInput", () => {
  it("groups by category preserving server order", () => {
    const groups = groupBlocksByCategory([heroBlock, spacerBlock, heroBlock]);
    expect(groups.map((g) => g.category)).toEqual(["hero", "layout"]);
    expect(groups[0]!.blocks).toHaveLength(2);
  });

  it("indexBlocks maps id → block", () => {
    expect(indexBlocks([heroBlock]).get("hero_text")).toBe(heroBlock);
  });

  it("buildComposeInput includes the subject only when non-empty", () => {
    const brand = {
      primary_color: "var-token",
      body_font: "Inter",
      heading_font: "Inter",
      background_color: "var-token",
    };
    const instances = [createInstance(heroBlock)];
    expect(buildComposeInput(brand, instances).subject).toBeUndefined();
    expect(buildComposeInput(brand, instances, "  ").subject).toBeUndefined();
    expect(buildComposeInput(brand, instances, " Hi ").subject).toBe("Hi");
    expect(buildComposeInput(brand, instances, "Hi").blocks).toBe(instances);
  });
});
