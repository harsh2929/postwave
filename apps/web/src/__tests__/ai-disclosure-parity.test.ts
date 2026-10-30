// SPDX-License-Identifier: AGPL-3.0-only
//
// The EU AI Act Article 50 disclosure constants are declared twice — once in
// Go for the gateway, once in TypeScript for web, desktop and mobile — and the
// TS package says so three times in prose:
//
//   "MUST equal `aidisclosure.DisclosureText` in the Go gateway."
//   "MUST equal `aidisclosure.Marker` in the Go gateway."
//   "MUST equal `aidisclosure.HeaderName` in the Go gateway."
//
// Nothing enforced any of the three. They agree today; the failure mode if
// they stop is quiet and asymmetric:
//
//   * DisclosureText — Art. 50(1) is a notice obligation. Two different
//     sentences is not a crash, it is two different disclosures shipped to
//     users under one compliance claim.
//   * Marker — Art. 50(2) machine-readable marking. If the gateway embeds one
//     string and clients search for another, AI-generated content stops being
//     detectable as such by exactly the mechanism the article requires.
//   * HeaderName — a header the producer sets and the consumer reads. A rename
//     on one side is a header nobody sets and nobody misses.
//
// Twelve client files import these constants, so a TS-side drift reaches every
// surface at once while the gateway keeps emitting the old value.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AI_DISCLOSURE_TEXT,
  AI_GENERATED_HEADER,
  AI_GENERATED_MARKER,
} from "@postwave/ai-disclosure";

const GO = readFileSync(
  resolve(process.cwd(), "../../apps/api/internal/aidisclosure/aidisclosure.go"),
  "utf8",
);

/** A `const Name = "value"` declaration in the Go package. */
function goConst(name: string): string {
  const m = new RegExp(`const ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(GO);
  expect(m, `${name} not found in aidisclosure.go`).not.toBeNull();
  return m![1]!;
}

describe("AI Act disclosure constants match across languages", () => {
  it("reads the Go source", () => {
    // Guard the guard: a moved or renamed Go file would otherwise make every
    // comparison below silently unavailable rather than failing.
    expect(GO).toContain("package aidisclosure");
    expect(GO.length).toBeGreaterThan(200);
  });

  it("uses one Article 50(1) notice", () => {
    expect(AI_DISCLOSURE_TEXT).toBe(goConst("DisclosureText"));
    // …and it has to actually disclose. An empty or whitespace value would
    // satisfy equality while disclosing nothing.
    expect(AI_DISCLOSURE_TEXT.trim().length).toBeGreaterThan(20);
    expect(AI_DISCLOSURE_TEXT).toMatch(/\bAI\b/);
  });

  it("uses one Article 50(2) machine-readable marker", () => {
    expect(AI_GENERATED_MARKER).toBe(goConst("Marker"));
    expect(AI_GENERATED_MARKER.trim()).not.toBe("");
  });

  it("uses one delivery header name", () => {
    expect(AI_GENERATED_HEADER).toBe(goConst("HeaderName"));
    // Header names are case-insensitive on the wire but compared literally in
    // several client paths; keep the canonical spelling stable.
    expect(AI_GENERATED_HEADER).toMatch(/^X-Postwave-/);
  });

  it("is actually rendered by client surfaces, not just declared", () => {
    // A disclosure package nothing imports is a compliance artifact, not a
    // disclosure. This is the property the deadline was about.
    const consumers = [
      "src/components/ai/copilot-rail.tsx",
      "src/app/(dashboard)/app/campaigns/campaign-create-dialog.tsx",
    ];
    for (const rel of consumers) {
      const text = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(text, `${rel} no longer imports the disclosure`).toMatch(
        /@postwave\/ai-disclosure/,
      );
    }
  });
});
