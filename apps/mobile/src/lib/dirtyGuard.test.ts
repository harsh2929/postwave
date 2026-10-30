import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDirty,
  markDirty,
  resetDirtyGuard,
  unsavedLabels,
  unsavedPrompt,
} from "@/lib/dirtyGuard";

beforeEach(() => {
  resetDirtyGuard();
});

describe("dirty registry", () => {
  it("tracks and clears sections independently", () => {
    markDirty("workspace", "Workspace");
    markDirty("api", "API connection");
    expect(unsavedLabels()).toEqual(["Workspace", "API connection"]);
    clearDirty("api");
    expect(unsavedLabels()).toEqual(["Workspace"]);
  });

  it("does not double-register a section that stays dirty", () => {
    markDirty("workspace", "Workspace");
    markDirty("workspace", "Workspace");
    expect(unsavedLabels()).toEqual(["Workspace"]);
  });

  it("ignores an empty id", () => {
    markDirty("", "Nothing");
    expect(unsavedLabels()).toEqual([]);
  });

  it("resets everything after a confirmed discard", () => {
    markDirty("a", "A");
    markDirty("b", "B");
    resetDirtyGuard();
    expect(unsavedLabels()).toEqual([]);
  });
});

describe("unsavedPrompt", () => {
  it("is null when nothing is dirty", () => {
    expect(unsavedPrompt([])).toBeNull();
    expect(unsavedPrompt(["  "])).toBeNull();
  });

  it("names a single section with singular agreement", () => {
    const prompt = unsavedPrompt(["Workspace"]);
    expect(prompt?.message).toBe(
      "Workspace has unsaved changes. Leaving now discards them.",
    );
  });

  it("lists several sections with plural agreement", () => {
    const prompt = unsavedPrompt(["Workspace", "API connection", "Webhook"]);
    expect(prompt?.message).toBe(
      "Workspace, API connection and Webhook have unsaved changes. Leaving now discards them.",
    );
  });
});
