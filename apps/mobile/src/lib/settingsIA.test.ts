import { describe, expect, it } from "vitest";

import {
  SETTINGS_ANCHORS,
  SETTINGS_CATEGORIES,
  filterSettingsByCategory,
  searchSettings,
} from "@/lib/settingsIA";

describe("SETTINGS_ANCHORS", () => {
  it("has unique keys", () => {
    const keys = SETTINGS_ANCHORS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only uses declared categories", () => {
    for (const anchor of SETTINGS_ANCHORS) {
      expect(SETTINGS_CATEGORIES).toContain(anchor.category);
    }
  });

  it("gives every entry at least one keyword", () => {
    // A label-only entry is a table of contents, not search.
    for (const anchor of SETTINGS_ANCHORS) {
      expect(anchor.keywords.length).toBeGreaterThan(0);
    }
  });
});

describe("searchSettings", () => {
  it("returns everything for an empty query", () => {
    expect(searchSettings("")).toHaveLength(SETTINGS_ANCHORS.length);
    expect(searchSettings("   ")).toHaveLength(SETTINGS_ANCHORS.length);
  });

  it("finds sections by the words users actually type", () => {
    // The headline case from the finding: "App lock" is buried, and nobody
    // types "app lock" — they type "face id".
    expect(searchSettings("face id").map((a) => a.key)).toContain("app-lock");
    expect(searchSettings("dark mode").map((a) => a.key)).toContain(
      "appearance",
    );
    expect(searchSettings("2fa").map((a) => a.key)).toContain("security");
    expect(searchSettings("gdpr").map((a) => a.key)).toContain(
      "privacy-requests",
    );
  });

  it("requires every token to match, so multi-word queries narrow", () => {
    const wide = searchSettings("webhook");
    const narrow = searchSettings("webhook alert");
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(narrow.map((a) => a.key)).toContain("webhook-alerts");
  });

  it("is case-insensitive and returns [] for nonsense", () => {
    expect(searchSettings("FACE ID").map((a) => a.key)).toContain("app-lock");
    expect(searchSettings("zzzz")).toEqual([]);
  });
});

describe("filterSettingsByCategory", () => {
  it("passes everything through for a null category", () => {
    expect(filterSettingsByCategory(SETTINGS_ANCHORS, null)).toHaveLength(
      SETTINGS_ANCHORS.length,
    );
  });

  it("narrows to one category", () => {
    const device = filterSettingsByCategory(SETTINGS_ANCHORS, "Device");
    expect(device.length).toBeGreaterThan(0);
    expect(device.every((a) => a.category === "Device")).toBe(true);
  });

  it("composes with search", () => {
    const result = filterSettingsByCategory(
      searchSettings("export"),
      "Privacy",
    );
    expect(result.map((a) => a.key)).toContain("workspace-exports");
    expect(result.every((a) => a.category === "Privacy")).toBe(true);
  });
});
