// SPDX-License-Identifier: AGPL-3.0-only
//
// The clipboard helper backs the cross-device "Copy link" control
// (components/copy-entity-link.tsx). The original component called
// `navigator.clipboard.writeText` directly with no existence guard and
// swallowed a rejected write into a no-op success path — so a copy could
// fail with zero user feedback. These tests pin the two behaviours that
// regression caused: (a) the missing-API guard, and (b) a *distinct*
// failure result for a rejected write.
//
// Runs under the node-only vitest environment by stubbing `navigator`
// inline (matching the project's existing DOM-global stubbing convention).

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";

type MutableGlobal = { navigator?: unknown };

function setNavigator(value: unknown): void {
  (globalThis as MutableGlobal).navigator = value;
}

const original = Object.prototype.hasOwnProperty.call(globalThis, "navigator")
  ? { present: true, value: (globalThis as MutableGlobal).navigator }
  : { present: false, value: undefined };

afterEach(() => {
  if (original.present) {
    setNavigator(original.value);
  } else {
    delete (globalThis as MutableGlobal).navigator;
  }
});

describe("isClipboardAvailable", () => {
  it("is false when navigator is undefined (SSR / non-DOM)", () => {
    delete (globalThis as MutableGlobal).navigator;
    expect(isClipboardAvailable()).toBe(false);
  });

  it("is false when navigator.clipboard is absent (non-secure context)", () => {
    setNavigator({});
    expect(isClipboardAvailable()).toBe(false);
  });

  it("is false when writeText is not a function", () => {
    setNavigator({ clipboard: {} });
    expect(isClipboardAvailable()).toBe(false);
  });

  it("is true when writeText exists", () => {
    setNavigator({ clipboard: { writeText: () => Promise.resolve() } });
    expect(isClipboardAvailable()).toBe(true);
  });
});

describe("copyToClipboard", () => {
  it("returns 'unavailable' instead of throwing when the API is missing", async () => {
    // The pre-fix component would have thrown a TypeError here (reading
    // .writeText of undefined) — the guard must yield a surfaced status.
    setNavigator({});
    await expect(copyToClipboard("https://app.moosewave.com/app/campaigns/cmp_1")).resolves.toBe(
      "unavailable",
    );
  });

  it("returns 'unavailable' when navigator itself is undefined", async () => {
    delete (globalThis as MutableGlobal).navigator;
    await expect(copyToClipboard("x")).resolves.toBe("unavailable");
  });

  it("returns 'copied' and writes the text on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });
    await expect(copyToClipboard("hello")).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("returns 'error' (a visible failure, not a swallowed success) when the write is rejected", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    setNavigator({ clipboard: { writeText } });
    // The bug: a rejected write previously left the UI unchanged. The helper
    // must distinguish a rejection from a success so callers can show it.
    await expect(copyToClipboard("hello")).resolves.toBe("error");
  });
});
