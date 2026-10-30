import { beforeEach, describe, expect, it } from "vitest";

import {
  MIN_REMEMBERED_OFFSET,
  clearScrollMemory,
  forgetScrollOffset,
  recallScrollOffset,
  rememberScrollOffset,
} from "@/lib/scrollMemory";

beforeEach(() => {
  clearScrollMemory();
});

describe("scrollMemory", () => {
  it("round-trips an offset per key", () => {
    rememberScrollOffset("more", 420);
    rememberScrollOffset("settings", 1200);
    expect(recallScrollOffset("more")).toBe(420);
    expect(recallScrollOffset("settings")).toBe(1200);
    expect(recallScrollOffset("unknown")).toBeNull();
  });

  it("does not remember trivial offsets", () => {
    rememberScrollOffset("more", MIN_REMEMBERED_OFFSET - 1);
    expect(recallScrollOffset("more")).toBeNull();
  });

  it("FORGETS when the user scrolls back to the top", () => {
    // The bug this prevents: remembering only large offsets means a user who
    // deliberately returned to the top gets yanked back down on their next
    // visit.
    rememberScrollOffset("more", 900);
    rememberScrollOffset("more", 0);
    expect(recallScrollOffset("more")).toBeNull();
  });

  it("ignores junk from a bounce/overscroll event", () => {
    rememberScrollOffset("more", 900);
    rememberScrollOffset("more", Number.NaN);
    rememberScrollOffset("more", undefined);
    expect(recallScrollOffset("more")).toBe(900);
  });

  it("supports explicit forgetting and a full wipe", () => {
    rememberScrollOffset("a", 100);
    rememberScrollOffset("b", 200);
    forgetScrollOffset("a");
    expect(recallScrollOffset("a")).toBeNull();
    expect(recallScrollOffset("b")).toBe(200);
    clearScrollMemory();
    expect(recallScrollOffset("b")).toBeNull();
  });
});
