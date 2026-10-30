/**
 * The one focus signal every stream is gated on.
 *
 * The property that is load-bearing for NATIVE#10: it must READ the same
 * focusManager that lib/connectivity bridges AppState into, on both edges and
 * only until unsubscribe. A second listener with its own idea of "foreground"
 * is how the two halves of a screen end up disagreeing about whether the app
 * is in front of the user; a subscription that never fires, or one that never
 * stops, is how a stream ends up either permanently closed or permanently
 * open.
 */
import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { queryFocusGate } from "./queryFocusGate";

afterEach(() => {
  focusManager.setFocused(undefined);
});

describe("queryFocusGate", () => {
  it("reports the focusManager the app already bridges AppState into", () => {
    focusManager.setFocused(true);
    expect(queryFocusGate.isFocused()).toBe(true);
    focusManager.setFocused(false);
    expect(queryFocusGate.isFocused()).toBe(false);
  });

  it("notifies subscribers on both edges", () => {
    focusManager.setFocused(true);
    const seen: boolean[] = [];
    const unsubscribe = queryFocusGate.subscribe((f) => seen.push(f));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    unsubscribe();
    focusManager.setFocused(false);
    expect(seen).toEqual([false, true]);
  });

  it("clearing the override reads as focused, not as backgrounded", () => {
    // `setFocused(undefined)` means "no override, use the default resolver".
    // A native runtime has no document, so that resolves to focused — and it
    // must, or clearing the override would close every stream permanently.
    focusManager.setFocused(false);
    expect(queryFocusGate.isFocused()).toBe(false);
    focusManager.setFocused(undefined);
    expect(queryFocusGate.isFocused()).toBe(true);
  });

  it("stops notifying after unsubscribe", () => {
    focusManager.setFocused(true);
    const seen: boolean[] = [];
    queryFocusGate.subscribe((f) => seen.push(f))();
    focusManager.setFocused(false);
    expect(seen).toEqual([]);
  });
});
