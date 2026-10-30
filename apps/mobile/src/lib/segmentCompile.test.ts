import { describe, expect, it } from "vitest";

import {
  COMPILE_TEXT_SOFT_MAX,
  compileFailure,
  defaultSegmentName,
  describeInputProblem,
  disclosureLines,
  parseAIDisclosure,
  parseCompiledDraft,
  parsePreviewCount,
  previewCountLabel,
  runeCount,
} from "./segmentCompile";
import { describeSaveGate } from "./segmentSaveGate";

describe("runeCount", () => {
  it("counts RUNES, matching Go's utf8.RuneCountInString", () => {
    // "😀" is two UTF-16 units but one rune; the server's cap is in runes.
    expect(runeCount("😀")).toBe(1);
    expect("😀".length).toBe(2);
    expect(runeCount("abc")).toBe(3);
  });
});

describe("describeInputProblem", () => {
  it("refuses an empty description", () => {
    expect(describeInputProblem("   ")).toContain("Describe the audience");
  });

  it("refuses one past the phone's soft cap, well below the server's 4096", () => {
    const problem = describeInputProblem("a".repeat(COMPILE_TEXT_SOFT_MAX + 1));
    expect(problem).toContain(String(COMPILE_TEXT_SOFT_MAX));
  });

  it("accepts a normal sentence", () => {
    expect(
      describeInputProblem("opened an email in the last 30 days"),
    ).toBeNull();
  });
});

describe("parseCompiledDraft", () => {
  it("reads the rules-engine 200 shape", () => {
    const draft = parseCompiledDraft(
      {
        ast: { op: "condition", field: "email", comparator: "exists" },
        engine_used: "rules",
        rationale: "matched the open-recency pattern",
        suggested_name: "Recent openers",
      },
      "rules",
    );
    expect(draft?.engineUsed).toBe("rules");
    expect(draft?.rationale).toBe("matched the open-recency pattern");
    expect(draft?.suggestedName).toBe("Recent openers");
    expect(draft?.ast).toEqual({
      op: "condition",
      field: "email",
      comparator: "exists",
    });
  });

  it("accepts query_ast / queryAst as the AST alias", () => {
    expect(parseCompiledDraft({ query_ast: { op: "and" } }, "rules")?.ast).toEqual({
      op: "and",
    });
    expect(parseCompiledDraft({ queryAst: { op: "or" } }, "rules")?.ast).toEqual({
      op: "or",
    });
  });

  it("carries the AI provenance envelope through", () => {
    const draft = parseCompiledDraft(
      {
        ast: { op: "and", children: [] },
        engine_used: "ai",
        ai_processing: { provider: "acme", retention: "not_declared" },
        nutrition_facts: { predicates: [] },
      },
      "ai",
    );
    expect(draft?.engineUsed).toBe("ai");
    expect(draft?.aiProcessing).toEqual({
      provider: "acme",
      retention: "not_declared",
    });
    expect(draft?.nutritionFacts).toEqual({ predicates: [] });
  });

  it("returns null when there is NO tree — an empty rule list is not a draft", () => {
    expect(parseCompiledDraft({ engine_used: "rules" }, "rules")).toBeNull();
    expect(parseCompiledDraft(null, "rules")).toBeNull();
    expect(parseCompiledDraft("nope", "rules")).toBeNull();
    expect(parseCompiledDraft([], "rules")).toBeNull();
  });
});

describe("parsePreviewCount", () => {
  it("never reports a CAPPED response as a count", () => {
    // The handler answers 200 {count: 0, capped: true} on its 10s deadline.
    const result = parsePreviewCount({
      count: 0,
      capped: true,
      computed_in_ms: 10001,
    });
    expect(result.capped).toBe(true);
    expect(result.count).toBeNull();
    expect(previewCountLabel(result)).toContain("Too large to count");
    expect(previewCountLabel(result)).not.toContain("0 people");
  });

  it("reads a real count", () => {
    const result = parsePreviewCount({
      count: 1423,
      capped: false,
      computed_in_ms: 42,
    });
    expect(result.count).toBe(1423);
    expect(result.computedInMs).toBe(42);
    expect(previewCountLabel(result)).toBe("1,423 people match right now.");
  });

  it("says 1 person, not 1 people", () => {
    expect(previewCountLabel(parsePreviewCount({ count: 1 }))).toBe(
      "1 person matches right now.",
    );
  });

  it("reports a genuine zero as zero", () => {
    expect(previewCountLabel(parsePreviewCount({ count: 0 }))).toBe(
      "0 people match right now.",
    );
  });

  it("treats a missing count as unknown, not zero", () => {
    const result = parsePreviewCount({ capped: false });
    expect(result.count).toBeNull();
    expect(previewCountLabel(result)).toContain("without a count");
  });

  it("says 'not previewed' for no result at all", () => {
    expect(previewCountLabel(null)).toBe("Not previewed yet.");
  });
});

describe("compileFailure", () => {
  it("offers the AI retry ONLY on 422 unsupported_text", () => {
    expect(
      compileFailure({ status: 422, code: "unsupported_text", message: "x" })
        .canRetryWithAI,
    ).toBe(true);
    // Same status, different code — a real failure, not a routing signal.
    expect(
      compileFailure({ status: 422, code: "bad_ast", message: "x" })
        .canRetryWithAI,
    ).toBe(false);
    expect(
      compileFailure({ status: 401, message: "session expired" })
        .canRetryWithAI,
    ).toBe(false);
    expect(
      compileFailure({ status: 500, message: "boom" }).canRetryWithAI,
    ).toBe(false);
  });

  it("explains an unconfigured AI compiler without offering a retry", () => {
    const failure = compileFailure({
      status: 503,
      code: "ai_unavailable",
      message: "internal",
    });
    expect(failure.canRetryWithAI).toBe(false);
    expect(failure.message).toContain("no AI compiler configured");
  });

  it("names the server's own length limit", () => {
    expect(
      compileFailure({ status: 400, code: "text_too_long", message: "x" })
        .message,
    ).toContain("4,096");
  });

  it("falls back to the server's message", () => {
    expect(
      compileFailure({ status: 418, message: "teapot" }).message,
    ).toBe("teapot");
  });
});

describe("parseAIDisclosure / disclosureLines", () => {
  it("defaults to UNAVAILABLE on an unreadable payload (fails closed)", () => {
    expect(parseAIDisclosure(null)).toEqual({
      available: false,
      processing: null,
    });
    expect(parseAIDisclosure({ available: "yes" }).available).toBe(false);
  });

  it("flattens arrays and skips nested objects", () => {
    const lines = disclosureLines({
      provider: "acme",
      data_categories: ["audience_description", "predicate_registry"],
      retention: "not_declared",
      nested: { a: 1 },
    });
    expect(lines).toEqual([
      { label: "Provider", value: "acme" },
      {
        label: "Data categories",
        value: "audience description, predicate registry",
      },
      { label: "Retention", value: "not declared" },
    ]);
  });

  it("returns nothing for no disclosure", () => {
    expect(disclosureLines(null)).toEqual([]);
  });
});

describe("defaultSegmentName", () => {
  const base = {
    ast: {},
    engineUsed: "rules" as const,
    rationale: null,
    aiProcessing: null,
    nutritionFacts: null,
  };

  it("prefers the server's suggestion", () => {
    expect(
      defaultSegmentName({ ...base, suggestedName: "Recent openers" }, "x"),
    ).toBe("Recent openers");
  });

  it("falls back to the operator's own words for the AI engine", () => {
    expect(
      defaultSegmentName(
        { ...base, suggestedName: null, engineUsed: "ai" },
        "  people   who  bought twice  ",
      ),
    ).toBe("people who bought twice");
  });

  it("truncates a long description on a RUNE boundary", () => {
    const name = defaultSegmentName(
      { ...base, suggestedName: null },
      "😀".repeat(100),
    );
    expect(Array.from(name)).toHaveLength(58); // 57 runes + the ellipsis
    expect(name.endsWith("…")).toBe(true);
  });

  it("never returns an empty name", () => {
    expect(defaultSegmentName({ ...base, suggestedName: null }, "   ")).toBe(
      "Described audience",
    );
  });
});

describe("describeSaveGate", () => {
  it("lets an EDITOR save — write:subscribers is in editorWriteScopes", () => {
    expect(
      describeSaveGate({ hasWriteRole: true, online: true, gated: false }),
    ).toEqual({ canSave: true });
  });

  it("gives the ROLE reason precedence over the connection", () => {
    const gate = describeSaveGate({
      hasWriteRole: false,
      online: false,
      gated: true,
    });
    expect(gate.canSave).toBe(false);
    expect(gate.reason).toContain("editor role");
  });

  it("asks for a reconnect before it blames the network", () => {
    expect(
      describeSaveGate({ hasWriteRole: true, online: false, gated: true })
        .reason,
    ).toContain("Reconnect");
    expect(
      describeSaveGate({ hasWriteRole: true, online: false, gated: false })
        .reason,
    ).toContain("offline");
  });
});
