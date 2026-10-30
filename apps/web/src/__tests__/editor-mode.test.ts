import { describe, expect, it } from "vitest";

import {
  isEditorMode,
  parseStoredEditorModes,
} from "@/components/editor/editor-mode";

describe("editor mode persistence", () => {
  it("accepts all rendered tabs, including cross-client preview", () => {
    expect(isEditorMode("writer")).toBe(true);
    expect(isEditorMode("blocks")).toBe(true);
    expect(isEditorMode("clients")).toBe(true);
  });

  it("drops corrupt or unknown persisted modes", () => {
    expect(parseStoredEditorModes("{bad json")).toEqual({});
    expect(
      parseStoredEditorModes(
        JSON.stringify({
          docA: "writer",
          docB: "clients",
          docC: "preview",
          docD: 1,
        }),
      ),
    ).toEqual({
      docA: "writer",
      docB: "clients",
    });
  });

  it("drops oversized, overlong, and excessive persisted mode entries", () => {
    expect(
      parseStoredEditorModes(
        JSON.stringify({ doc: "writer", big: "x".repeat(70 * 1024) }),
      ),
    ).toEqual({});

    const overlongId = "d".repeat(257);
    expect(
      parseStoredEditorModes(JSON.stringify({ [overlongId]: "writer", ok: "blocks" })),
    ).toEqual({ ok: "blocks" });

    expect(
      parseStoredEditorModes(
        JSON.stringify({
          " doc": "writer",
          "doc\nx": "blocks",
          ok: "clients",
        }),
      ),
    ).toEqual({ ok: "clients" });

    const many = Object.fromEntries(
      Array.from({ length: 550 }, (_, i) => [`doc_${i}`, "writer"]),
    );
    expect(Object.keys(parseStoredEditorModes(JSON.stringify(many)))).toHaveLength(500);
  });
});
