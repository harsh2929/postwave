/**
 * The mobile half of the shared hint contract stays in step with the schema.
 *
 * Two directions, both asserted: a hint the schema gains without a mobile
 * anchor (or an explicit not-applicable) fails here, and an anchor for a hint
 * the schema dropped fails here. Either way the table is corrected by hand,
 * with the reason, rather than drifting silently the way the whole contract
 * did on mobile for two months.
 */
import { CONTEXTUAL_HINTS } from "@postwave/onboarding-schema";
import { describe, expect, it } from "vitest";

import {
  MOBILE_HINT_ANCHORS,
  contextualHint,
  isDkimRecord,
} from "./contextualHints";

describe("MOBILE_HINT_ANCHORS", () => {
  it("names every shared hint exactly once", () => {
    const schema = Object.keys(CONTEXTUAL_HINTS).sort();
    const table = MOBILE_HINT_ANCHORS.map((a) => a.hintKey).sort();
    expect(table).toEqual(schema);
    expect(new Set(table).size).toBe(table.length);
  });

  it("gives every anchor or exclusion a stated reason", () => {
    for (const row of MOBILE_HINT_ANCHORS) {
      const text = "anchor" in row ? row.anchor : row.notApplicable;
      expect(text.trim().length, row.hintKey).toBeGreaterThan(20);
    }
  });

  it("records import.consent as not applicable, with the reason", () => {
    const row = MOBILE_HINT_ANCHORS.find((a) => a.hintKey === "import.consent");
    expect(row && "notApplicable" in row ? row.notApplicable : "").toMatch(/no consent-source input/u);
  });

  it("exposes the shared copy, and nothing for an unknown key", () => {
    expect(contextualHint("sending-identity.dkim")?.title).toBe(
      CONTEXTUAL_HINTS["sending-identity.dkim"]?.title,
    );
    expect(contextualHint("no-such-hint")).toBeNull();
  });
});

describe("isDkimRecord", () => {
  it("matches the selector._domainkey TXT and CNAME forms", () => {
    expect(isDkimRecord({ type: "TXT", name: "pw1._domainkey.example.com" })).toBe(true);
    expect(isDkimRecord({ type: "CNAME", name: "s2._domainkey.example.com" })).toBe(true);
    expect(isDkimRecord({ type: "TXT", name: "_domainkey" })).toBe(true);
  });
  it("matches an API that labels the type outright", () => {
    expect(isDkimRecord({ type: "DKIM", name: "anything" })).toBe(true);
    expect(isDkimRecord({ type: " dkim ", name: "x" })).toBe(true);
  });
  it("does not match SPF, DMARC or an unrelated TXT", () => {
    expect(isDkimRecord({ type: "TXT", name: "example.com" })).toBe(false);
    expect(isDkimRecord({ type: "TXT", name: "_dmarc.example.com" })).toBe(false);
    expect(isDkimRecord({ type: "TXT", name: "notdomainkey.example.com" })).toBe(false);
    expect(isDkimRecord({ type: "MX", name: "example.com" })).toBe(false);
  });
});
