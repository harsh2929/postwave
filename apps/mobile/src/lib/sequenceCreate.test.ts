import { describe, expect, it } from "vitest";

import {
  SEQUENCE_CREATE_SCOPE_NOTE,
  SEQUENCE_NAME_MAX_RUNES,
  canCreateSequence,
  nameRemaining,
  runeCount,
  sequenceCreateErrorMessage,
  sequenceCreatedMessage,
  validateSequenceName,
} from "./sequenceCreate";

/**
 * Control characters are BUILT from code points here, never pasted as literal
 * bytes: an invisible NUL or DEL in a fixture is unreviewable, and a linter
 * that normalises whitespace can silently delete the thing under test.
 */
const ctrl = (code: number): string => String.fromCodePoint(code);

describe("runeCount", () => {
  it("counts code points, not UTF-16 units", () => {
    // "🚀" is one rune to Go's utf8.RuneCountInString and two to String#length.
    expect("🚀".length).toBe(2);
    expect(runeCount("🚀")).toBe(1);
    expect(runeCount("héllo")).toBe(5);
    expect(runeCount("")).toBe(0);
  });
});

describe("validateSequenceName", () => {
  it("accepts a normal name and returns it TRIMMED", () => {
    const result = validateSequenceName("  Winback series  ");
    expect(result).toEqual({ ok: true, name: "Winback series" });
  });

  it("rejects empty and whitespace-only names", () => {
    for (const raw of ["", "   ", "\t \t"]) {
      const result = validateSequenceName(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("Give the sequence a name.");
    }
  });

  it("accepts exactly the server ceiling and rejects one past it", () => {
    const atLimit = "a".repeat(SEQUENCE_NAME_MAX_RUNES);
    expect(validateSequenceName(atLimit).ok).toBe(true);
    const overLimit = "a".repeat(SEQUENCE_NAME_MAX_RUNES + 1);
    const result = validateSequenceName(overLimit);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("200 characters");
  });

  it("measures length in RUNES, so 200 emoji fit where 200 surrogate pairs would not", () => {
    const emoji = "🚀".repeat(SEQUENCE_NAME_MAX_RUNES);
    expect(emoji.length).toBe(SEQUENCE_NAME_MAX_RUNES * 2);
    expect(validateSequenceName(emoji).ok).toBe(true);
  });

  it("measures length on the RAW value, matching validateSingleLine", () => {
    // The server trims only for the required-check; the rune ceiling is
    // applied to the untrimmed string. A name whose padding pushes it past
    // the limit must therefore fail, not be silently trimmed into range.
    const padded = " ".repeat(10) + "a".repeat(SEQUENCE_NAME_MAX_RUNES);
    expect(validateSequenceName(padded).ok).toBe(false);
  });

  it("rejects the control characters the handler refuses", () => {
    const cases = [
      "two\nlines",
      "two\rlines",
      "tab\tseparated",
      `nul${ctrl(0x00)}byte`,
      `del${ctrl(0x7f)}here`,
      `c1${ctrl(0x85)}next-line`,
    ];
    for (const raw of cases) {
      const result = validateSequenceName(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          "A sequence name has to be a single line of plain text.",
        );
      }
    }
  });

  it("does not mistake ordinary punctuation or accents for control bytes", () => {
    for (const raw of [
      "Q3 — winback (v2)",
      "Réengagement · 2026",
      "50% off!",
    ]) {
      expect(validateSequenceName(raw).ok).toBe(true);
    }
  });

  it("reports emptiness before length, so an untouched field says the useful thing", () => {
    const result = validateSequenceName(
      " ".repeat(SEQUENCE_NAME_MAX_RUNES + 5),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Give the sequence a name.");
  });
});

describe("nameRemaining", () => {
  it("stays quiet until the field is near the ceiling", () => {
    expect(nameRemaining("")).toBeNull();
    expect(nameRemaining("a".repeat(100))).toBeNull();
    expect(nameRemaining("a".repeat(159))).toBeNull();
  });

  it("counts down inside the last 40 characters", () => {
    expect(nameRemaining("a".repeat(160))).toBe(40);
    expect(nameRemaining("a".repeat(200))).toBe(0);
  });

  it("goes negative past the ceiling rather than clamping to zero", () => {
    // A clamped 0 would read the same as "exactly full" while the field is
    // in fact invalid — the counter has to be able to say how far over.
    expect(nameRemaining("a".repeat(205))).toBe(-5);
  });
});

describe("sequenceCreateErrorMessage", () => {
  it("names the role problem on 403", () => {
    expect(sequenceCreateErrorMessage(403)).toContain("role can't create");
  });

  it("treats 404/405/501 as a deployment answer, not a failure", () => {
    for (const status of [404, 405, 501]) {
      expect(sequenceCreateErrorMessage(status)).toContain(
        "doesn't expose sequence creation",
      );
    }
  });

  it("surfaces the server's own text for a 400, because that IS the reason", () => {
    expect(
      sequenceCreateErrorMessage(400, 'json: unknown field "description"'),
    ).toBe('json: unknown field "description"');
  });

  it("falls back to a generic sentence when the server said nothing useful", () => {
    expect(sequenceCreateErrorMessage(400, "   ")).toBe(
      "Couldn't create this sequence.",
    );
    expect(sequenceCreateErrorMessage(0)).toBe(
      "Couldn't create this sequence.",
    );
  });

  it("does not blame the operator for a 5xx", () => {
    expect(sequenceCreateErrorMessage(500)).toContain("Try again shortly");
    expect(sequenceCreateErrorMessage(503)).toContain("unavailable right now");
  });

  it("explains the runtime 409 rather than implying a name clash", () => {
    expect(sequenceCreateErrorMessage(409)).toContain(
      "Live sequence statuses aren't available",
    );
  });
});

describe("sequenceCreatedMessage", () => {
  it("distinguishes a created draft from a queued one", () => {
    expect(sequenceCreatedMessage({ name: "Winback", queued: false })).toBe(
      "“Winback” created as an empty draft.",
    );
    expect(sequenceCreatedMessage({ name: "Winback", queued: true })).toBe(
      "“Winback” will be created when you're back online.",
    );
  });

  it("degrades to a neutral subject rather than empty quotes", () => {
    expect(sequenceCreatedMessage({ name: "  ", queued: false })).toBe(
      "The sequence created as an empty draft.",
    );
  });
});

describe("SEQUENCE_CREATE_SCOPE_NOTE", () => {
  it("says the draft is empty and where steps are added", () => {
    expect(SEQUENCE_CREATE_SCOPE_NOTE).toContain("empty draft");
    expect(SEQUENCE_CREATE_SCOPE_NOTE).toContain("desktop or web");
  });
});

describe("canCreateSequence", () => {
  const base = { hasTenant: true, unavailable: false, canWrite: true };

  it("offers create for an editor on a deployed endpoint", () => {
    expect(canCreateSequence(base)).toBe(true);
  });

  it("hides create without a workspace identity to stamp a queued write with", () => {
    expect(canCreateSequence({ ...base, hasTenant: false })).toBe(false);
  });

  it("hides create when the route is not deployed", () => {
    expect(canCreateSequence({ ...base, unavailable: true })).toBe(false);
  });

  it("hides create for a read-only role instead of showing a button that 403s", () => {
    expect(canCreateSequence({ ...base, canWrite: false })).toBe(false);
  });

  it("takes no online flag at all — create is queue-capable, unlike delete", () => {
    // Guard against someone "fixing" this by adding an online gate: that
    // would suppress the one write on the screen built to survive offline.
    expect(canCreateSequence.length).toBe(1);
    expect(Object.keys(base)).toEqual(["hasTenant", "unavailable", "canWrite"]);
  });
});
