import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AI_DISCLOSURE_TEXT,
  AI_GENERATED_HEADER,
  AI_GENERATED_MARKER,
} from "./index.js";

// Cross-language drift guard: the client mirror MUST equal the Go gateway's
// canonical Art. 50 constants (apps/api/internal/aidisclosure/aidisclosure.go).
// Mirrors @postwave/notifications' Go-allowlist guard. If the legal text ever
// changes it changes in ONE place (the Go const) and this test forces the
// client mirror to follow — the whole point of centralizing the disclosure.
describe("AI-disclosure ↔ Go gateway drift guard", () => {
  const goSource = readFileSync(
    resolve(process.cwd(), "../..", "apps/api/internal/aidisclosure/aidisclosure.go"),
    "utf8",
  );

  const constOf = (name: string): string => {
    const m = goSource.match(new RegExp(`const ${name} = "((?:[^"\\\\]|\\\\.)*)"`, "u"));
    if (!m) throw new Error(`Go const ${name} not found in aidisclosure.go`);
    const [, literal] = m;
    // Unreachable while the pattern keeps its capture group. Throwing rather
    // than defaulting to "" keeps the guard honest: an empty literal would make
    // the drift assertions compare the client mirror against nothing.
    if (literal === undefined) {
      throw new Error(`Go const ${name} matched with no captured literal`);
    }
    // Unescape the Go string literal (only \" and \\ appear in these consts).
    return literal.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  };

  it("AI_DISCLOSURE_TEXT equals aidisclosure.DisclosureText (Art. 50(1))", () => {
    expect(AI_DISCLOSURE_TEXT).toBe(constOf("DisclosureText"));
  });

  it("AI_GENERATED_MARKER equals aidisclosure.Marker (Art. 50(2))", () => {
    expect(AI_GENERATED_MARKER).toBe(constOf("Marker"));
  });

  it("AI_GENERATED_HEADER equals aidisclosure.HeaderName", () => {
    expect(AI_GENERATED_HEADER).toBe(constOf("HeaderName"));
  });

  it("the disclosure text is non-empty and mentions AI", () => {
    expect(AI_DISCLOSURE_TEXT.length).toBeGreaterThan(0);
    expect(AI_DISCLOSURE_TEXT.toLowerCase()).toContain("ai");
  });
});
