// SPDX-License-Identifier: AGPL-3.0-only
//
// Display-side redaction of model-authored brief text. The expectations are
// literal strings, not derived from the patterns under test, so a weakened
// pattern fails here instead of passing silently.

import { describe, expect, it } from "vitest";

import {
  MAX_BRIEF_INSIGHT_ITEMS,
  safeBriefList,
  safeBriefText,
} from "@/lib/ai-brief-redaction";

describe("safeBriefText", () => {
  it("redacts each class of identifying or secret text", () => {
    expect(safeBriefText("contact ada@example.com today", 200)).toBe(
      "contact [email redacted] today",
    );
    expect(safeBriefText("see https://evil.example/path?q=1 now", 200)).toBe(
      "see [link redacted] now",
    );
    expect(safeBriefText("visit evil.example for details", 200)).toBe(
      "visit [link redacted] for details",
    );
    expect(
      safeBriefText("id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 bounced", 200),
    ).toBe("id [identifier redacted] bounced");
    expect(safeBriefText("subscriber_id: 8f3a2b1c9d bounced", 200)).toBe(
      "[profile identifier redacted] bounced",
    );
    expect(safeBriefText("call +1 (415) 555-0100 now", 200)).toBe(
      "call [phone redacted] now",
    );
    expect(safeBriefText("api_key=abc123secret leaked", 200)).toBe(
      "api_key: [credential redacted] leaked",
    );
    expect(safeBriefText("Authorization: Bearer eyTOKEN.part", 200)).toBe(
      "Authorization: [credential redacted]",
    );
    expect(safeBriefText("key ghp_abcdefgh12345 in logs", 200)).toBe(
      "key [credential redacted] in logs",
    );
  });

  it("strips control and bidi characters and collapses whitespace", () => {
    expect(safeBriefText("a\u202eb\n\n  c", 200)).toBe("a [control removed] b c");
  });

  it("bounds the length after redaction and ignores non-strings", () => {
    expect(safeBriefText("x".repeat(50), 10)).toBe("x".repeat(10));
    expect(safeBriefText(42, 10)).toBe("");
    expect(safeBriefText(null, 10)).toBe("");
  });

  it("scans past the display bound, so truncation never leaves a secret fragment too short to match", () => {
    // Cut first and "ghp_abcdefgh12345" becomes "ghp_abc", which the token
    // pattern (prefix + 8 chars) no longer recognises, so the fragment would
    // leak. Redacting the whole token before the cut shows the placeholder.
    const out = safeBriefText("xx ghp_abcdefgh12345 in logs", 10);
    expect(out).toBe("xx [creden");
    expect(out).not.toContain("ghp_");
  });
});

describe("safeBriefList", () => {
  it("redacts each item, drops empties, and keeps at most eight", () => {
    const items = Array.from({ length: 12 }, (_, i) => `item ${i} ada@example.com`);
    const out = safeBriefList([...items.slice(0, 2), "", 7, ...items.slice(2)]);
    expect(out).toHaveLength(MAX_BRIEF_INSIGHT_ITEMS - 2);
    expect(out[0]).toBe("item 0 [email redacted]");
    expect(out.join(" ")).not.toContain("ada@example.com");
    expect(safeBriefList("not a list")).toEqual([]);
  });
});
