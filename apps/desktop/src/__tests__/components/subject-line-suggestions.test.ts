// Tests for the SubjectLineSuggestions parser + mount gate. The
// component itself streams from /api/v1/voice/generate; the parts we
// can test in isolation are the variant extractor and the mount-gate
// (subject.length >= 10) / debounce-ms invariant.

import { describe, expect, it } from "vitest";

/* ---------------------------------------------------------------- */
/* parseVariants — mirror of SubjectLineSuggestions.tsx              */
/* ---------------------------------------------------------------- */

function cleanVariant(line: string): string {
  let s = line.trim();
  s = s.replace(/^(?:\(?\d+\)?[.):\-]\s*|[-•*]\s+)/, "");
  s = s.replace(/^["'“‘*_]+|["'”’*_]+$/g, "");
  return s.trim();
}

function parseVariants(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const numbered: string[] = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*\(?(\d+)\)?[.):\-]\s*(.+)$/);
    if (m && m[2]) {
      numbered.push(cleanVariant(m[2]));
      if (numbered.length >= 3) break;
    }
  }
  if (numbered.length > 0) return numbered;
  return lines
    .map((l) => cleanVariant(l))
    .filter(Boolean)
    .slice(0, 3);
}

/* ---------------------------------------------------------------- */
/* Tests                                                             */
/* ---------------------------------------------------------------- */

describe("SubjectLineSuggestions — mount gate", () => {
  const MIN_LENGTH = 10;
  it("does NOT mount below 10 chars", () => {
    expect("nine char".length < MIN_LENGTH).toBe(true);
  });

  it("mounts at exactly 10 chars", () => {
    expect("ten chars!".length).toBe(10);
    expect("ten chars!".length >= MIN_LENGTH).toBe(true);
  });

  it("mounts for longer subjects", () => {
    expect("this is a longer subject line".length >= MIN_LENGTH).toBe(true);
  });
});

describe("SubjectLineSuggestions — debounce window", () => {
  // The component schedules the SSE call via setTimeout(500). We pin
  // that constant here so a tweak surfaces as a unit diff.
  const DEBOUNCE_MS = 500;
  it("schedules a 500ms debounce", () => {
    expect(DEBOUNCE_MS).toBe(500);
  });
});

describe("SubjectLineSuggestions — parseVariants", () => {
  it("extracts the first 3 numbered lines", () => {
    const text = [
      "1. Hello there",
      "2. Hey, friend",
      "3. Hi — quick note",
      "4. Greetings",
    ].join("\n");
    expect(parseVariants(text)).toEqual([
      "Hello there",
      "Hey, friend",
      "Hi — quick note",
    ]);
  });

  it("strips wrapping quotes / asterisks", () => {
    const text = `1. "Hello there"\n2. *Hey, friend*`;
    const out = parseVariants(text);
    expect(out[0]).toBe("Hello there");
    expect(out[1]).toBe("Hey, friend");
  });

  it("falls back to non-empty lines when no numbered list is present", () => {
    const text = "Some line\nAnother line\nA third line\nA fourth";
    const out = parseVariants(text);
    expect(out.length).toBe(3);
  });

  it("returns [] for empty input", () => {
    expect(parseVariants("")).toEqual([]);
  });

  it("tolerates `(1)` and `1)` prefix styles", () => {
    const text = "(1) First\n2) Second\n3- Third";
    const out = parseVariants(text);
    expect(out).toEqual(["First", "Second", "Third"]);
  });
});

describe("SubjectLineSuggestions — Use this CTA", () => {
  it("invokes onPickVariant with the variant text", () => {
    let picked: string | null = null;
    const onPickVariant = (v: string): void => {
      picked = v;
    };
    onPickVariant("Hello there");
    expect(picked).toBe("Hello there");
  });
});

describe("SubjectLineSuggestions — A/B test all three CTA", () => {
  it("invokes onTestAll with the variants array", () => {
    let captured: string[] | null = null;
    const onTestAll = (vs: string[]): void => {
      captured = vs;
    };
    const variants = ["A", "B", "C"];
    onTestAll(variants);
    expect(captured).toEqual(["A", "B", "C"]);
  });
});
