/**
 * utf8ByteLength had no test (NATIVE#51) despite being the measuring stick for
 * three separate BOUNDS in the native cluster:
 *
 *   - lib/widgetData.ts truncates the workspace name to 128 UTF-8 bytes before
 *     it crosses into the App Group, and the Swift side re-validates that
 *     bound — a JS/Swift disagreement makes the widget silently render the
 *     empty state;
 *   - api/eventBus.ts caps event frames by byte length;
 *   - lib/deepLinks.ts caps the notification JSON it will parse.
 *
 * Every one of those is a byte budget, and `String.length` counts UTF-16 code
 * units, so the whole point of this function is that the two numbers differ.
 * The test cross-checks against Node's Buffer for well-formed input — an
 * independent implementation of the same spec — and then pins the lone-surrogate
 * behaviour Buffer and this function are ALLOWED to agree on but which no
 * caller should ever have to guess at.
 */
import { describe, expect, it } from "vitest";

import { utf8ByteLength } from "./utf8";

describe("utf8ByteLength", () => {
  it("counts the empty string as zero", () => {
    expect(utf8ByteLength("")).toBe(0);
  });

  it.each([
    ["ASCII", "Moosewave", 8],
    ["one-byte punctuation", "a-b_c.d", 7],
    ["two-byte Latin", "café", 5],
    ["two-byte Cyrillic", "Привет", 12],
    ["three-byte currency", "€", 3],
    ["three-byte CJK", "郵便波", 9],
    ["four-byte emoji", "🚀", 4],
    ["emoji with a ZWJ sequence", "👩‍🚀", 11],
    ["mixed", "Acme € 🚀", 13],
  ])("measures %s", (_name, input, expected) => {
    expect(utf8ByteLength(input)).toBe(expected);
    // Independent oracle: Node encodes the same spec.
    expect(utf8ByteLength(input)).toBe(Buffer.byteLength(input, "utf8"));
  });

  it("is not String.length for anything outside ASCII", () => {
    const workspace = "Größte Kampagnen 🚀";
    expect(workspace.length).toBe(19);
    expect(utf8ByteLength(workspace)).toBe(23);
  });

  it("counts a surrogate PAIR once, as four bytes — not twice as three", () => {
    // The failure this guards: treating each UTF-16 unit separately yields 6,
    // which over-counts every emoji and truncates workspace names early.
    const rocket = "🚀";
    expect(rocket.length).toBe(2);
    expect(utf8ByteLength(rocket)).toBe(4);
  });

  it("charges a lone surrogate three bytes, wherever it sits", () => {
    // Unpaired surrogates cannot be encoded; every encoder substitutes U+FFFD,
    // which is three bytes. Pinned at both ends of the string because the
    // trailing case takes a different branch (there is no `i + 1` to inspect).
    expect(utf8ByteLength("\uD83D")).toBe(3); // lone high, at the end
    expect(utf8ByteLength("\uDE80")).toBe(3); // lone low
    expect(utf8ByteLength("\uD83Dx")).toBe(4); // lone high, followed by ASCII
    expect(utf8ByteLength("a\uD83D")).toBe(4);
  });

  it("stays exact across a long mixed string", () => {
    const long = "Moosewave · Kampagne 2026 — 郵便 🚀".repeat(50);
    expect(utf8ByteLength(long)).toBe(Buffer.byteLength(long, "utf8"));
  });

  it("bounds the widget workspace field the way widgetData assumes", () => {
    // 128 bytes is the App Group contract. Thirty-two rockets is exactly the
    // budget; thirty-three overruns it while String.length still reads 66.
    const atBudget = "🚀".repeat(32);
    const overBudget = "🚀".repeat(33);
    expect(utf8ByteLength(atBudget)).toBe(128);
    expect(utf8ByteLength(overBudget)).toBeGreaterThan(128);
    expect(overBudget.length).toBeLessThan(128);
  });
});
