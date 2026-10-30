import { describe, expect, it } from "vitest";

import {
  checklistGlyph,
  checklistTone,
  normalizeChecklist,
  summarizeChecklist,
} from "./campaignChecklist";

const PASSING = {
  ready: true,
  checks: [
    { key: "subject_set", label: "Subject set", status: "pass", detail: "ok" },
    { key: "body_non_empty", label: "Body", status: "pass", detail: "ok" },
  ],
};

describe("normalizeChecklist", () => {
  it("survives a payload with no checks array", () => {
    expect(normalizeChecklist(null)).toEqual([]);
    expect(normalizeChecklist({})).toEqual([]);
    expect(normalizeChecklist({ checks: "nope" })).toEqual([]);
  });

  it("drops non-object rows and defaults a missing label to the key", () => {
    const items = normalizeChecklist({
      checks: [null, { key: "list_selected", status: "fail" }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("list_selected");
    expect(items[0]?.detail).toBe("");
  });

  it("treats an unrecognised status as a warning, never a pass", () => {
    const items = normalizeChecklist({
      checks: [{ key: "x", label: "X", status: "unknown_future_state" }],
    });
    expect(items[0]?.status).toBe("warn");
  });
});

describe("summarizeChecklist", () => {
  it("reports all-clear", () => {
    const s = summarizeChecklist(PASSING);
    expect(s.ready).toBe(true);
    expect(s.passCount).toBe(2);
    expect(s.failCount).toBe(0);
    expect(s.headline).toBe("All pre-send checks passed");
  });

  it("blocks when any gate fails and names the offenders", () => {
    const s = summarizeChecklist({
      ready: true, // server disagreeing with its own data must not unblock
      checks: [
        { key: "a", label: "Unsubscribe link", status: "fail", detail: "" },
        { key: "b", label: "From domain", status: "fail", detail: "" },
        { key: "c", label: "Subject", status: "pass", detail: "" },
      ],
    });
    expect(s.ready).toBe(false);
    expect(s.failCount).toBe(2);
    expect(s.blockingLabels).toEqual(["Unsubscribe link", "From domain"]);
    expect(s.headline).toBe("2 checks failed");
  });

  it("stays ready with warnings but says how many", () => {
    const s = summarizeChecklist({
      ready: true,
      checks: [
        { key: "a", label: "Recipients", status: "warn", detail: "unknown" },
        { key: "b", label: "Subject", status: "pass", detail: "" },
      ],
    });
    expect(s.ready).toBe(true);
    expect(s.warnCount).toBe(1);
    expect(s.headline).toContain("1 warning");
  });

  it("respects an explicit ready:false even with no failing rows", () => {
    const s = summarizeChecklist({
      ready: false,
      checks: [{ key: "a", label: "Subject", status: "pass", detail: "" }],
    });
    expect(s.ready).toBe(false);
  });

  it("is not ready when the payload has no checks at all", () => {
    const s = summarizeChecklist({ checks: [] });
    expect(s.ready).toBe(false);
    expect(s.headline).toContain("unavailable");
  });

  it("pluralises a single failure", () => {
    const s = summarizeChecklist({
      checks: [{ key: "a", label: "Body", status: "fail", detail: "" }],
    });
    expect(s.headline).toBe("1 check failed");
  });
});

describe("checklistTone / checklistGlyph", () => {
  it("pairs every colour with a non-colour glyph", () => {
    expect(checklistTone("pass")).toBe("success");
    expect(checklistTone("warn")).toBe("warning");
    expect(checklistTone("fail")).toBe("danger");
    expect(checklistGlyph("pass")).toBe("✓");
    expect(checklistGlyph("warn")).toBe("!");
    expect(checklistGlyph("fail")).toBe("✕");
  });
});
