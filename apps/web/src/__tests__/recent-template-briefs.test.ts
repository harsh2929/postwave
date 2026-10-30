// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearTemplateBriefs,
  mergeRecentBrief,
  pushRecentTemplateBrief,
  readRecentTemplateBriefs,
  readSavedTemplateBriefs,
  removeSavedTemplateBrief,
  saveTemplateBrief,
} from "@/lib/recent-template-briefs";

const SCOPE = { tenantId: "tenant-a", userId: "user-a" };

describe("mergeRecentBrief", () => {
  it("prepends the newest brief, trimmed", () => {
    expect(mergeRecentBrief(["a"], "  b  ")).toEqual(["b", "a"]);
  });

  it("de-duplicates case-insensitively and moves the match to the front", () => {
    expect(mergeRecentBrief(["Alpha", "Beta"], "alpha")).toEqual([
      "alpha",
      "Beta",
    ]);
  });

  it("caps the list at the max", () => {
    expect(mergeRecentBrief(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });

  it("leaves the list unchanged for a blank brief", () => {
    expect(mergeRecentBrief(["a", "b"], "   ")).toEqual(["a", "b"]);
  });
});

describe("saved template briefs (TMPL-042)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("pins a brief and reads it back trimmed", () => {
    saveTemplateBrief(SCOPE, "  House style: warm, concise  ");
    expect(readSavedTemplateBriefs(SCOPE)).toEqual([
      "House style: warm, concise",
    ]);
  });

  it("de-duplicates case-insensitively, newest first", () => {
    saveTemplateBrief(SCOPE, "Alpha");
    saveTemplateBrief(SCOPE, "Beta");
    saveTemplateBrief(SCOPE, "alpha");
    expect(readSavedTemplateBriefs(SCOPE)).toEqual(["alpha", "Beta"]);
  });

  it("ignores a blank brief", () => {
    saveTemplateBrief(SCOPE, "Keep");
    saveTemplateBrief(SCOPE, "   ");
    expect(readSavedTemplateBriefs(SCOPE)).toEqual(["Keep"]);
  });

  it("removes a pinned brief case-insensitively", () => {
    saveTemplateBrief(SCOPE, "Alpha");
    saveTemplateBrief(SCOPE, "Beta");
    expect(removeSavedTemplateBrief(SCOPE, "ALPHA")).toEqual(["Beta"]);
    expect(readSavedTemplateBriefs(SCOPE)).toEqual(["Beta"]);
  });

  it("isolates recent and saved briefs by exact tenant and user", () => {
    const otherUser = { tenantId: "tenant-a", userId: "user-b" };
    const otherTenant = { tenantId: "tenant-b", userId: "user-a" };

    pushRecentTemplateBrief(SCOPE, "Private recent");
    saveTemplateBrief(SCOPE, "Private saved");

    expect(readRecentTemplateBriefs(SCOPE)).toEqual(["Private recent"]);
    expect(readSavedTemplateBriefs(SCOPE)).toEqual(["Private saved"]);
    expect(readRecentTemplateBriefs(otherUser)).toEqual([]);
    expect(readSavedTemplateBriefs(otherUser)).toEqual([]);
    expect(readRecentTemplateBriefs(otherTenant)).toEqual([]);
    expect(readSavedTemplateBriefs(otherTenant)).toEqual([]);
  });

  it("fails closed instead of migrating unscoped legacy data", () => {
    window.localStorage.setItem(
      "postwave.template.recent-briefs",
      JSON.stringify(["Someone else's brief"]),
    );
    window.localStorage.setItem(
      "postwave.template.saved-briefs",
      JSON.stringify(["Someone else's saved brief"]),
    );

    expect(readRecentTemplateBriefs(SCOPE)).toEqual([]);
    expect(readSavedTemplateBriefs(SCOPE)).toEqual([]);
    expect(
      window.localStorage.getItem("postwave.template.recent-briefs"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("postwave.template.saved-briefs"),
    ).toBeNull();
  });

  it("clears only the requested account/workspace scope", () => {
    const other = { tenantId: "tenant-b", userId: "user-b" };
    saveTemplateBrief(SCOPE, "Remove me");
    saveTemplateBrief(other, "Keep me");

    clearTemplateBriefs(SCOPE);

    expect(readSavedTemplateBriefs(SCOPE)).toEqual([]);
    expect(readSavedTemplateBriefs(other)).toEqual(["Keep me"]);
  });
});
