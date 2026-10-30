/** Unit tests for interpretClipboardOrQr (pure QR/clipboard interpreter). */
import { describe, expect, it } from "vitest";

import { interpretClipboardOrQr } from "./qr";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

describe("interpretClipboardOrQr — entity (moosewave:// deep links)", () => {
  it("maps a campaign deep link to its detail route", () => {
    expect(interpretClipboardOrQr("moosewave://campaign/abc123")).toEqual({
      kind: "entity",
      href: "/(tabs)/campaigns/abc123",
    });
  });

  it("maps a subscriber deep link to its detail route", () => {
    expect(interpretClipboardOrQr("moosewave://subscriber/sub_99")).toEqual({
      kind: "entity",
      href: "/(tabs)/subscribers/sub_99",
    });
  });

  it("maps an approval deep link to the request, not to the queue", () => {
    // Scanning the QR a desktop approval card renders is the "approve on my
    // phone" gesture; while route-map's `approval.mobileDetail` was stale at
    // `false` this landed on the queue and the approver had to find the row
    // they had just scanned.
    expect(interpretClipboardOrQr("moosewave://approval/req_1")).toEqual({
      kind: "entity",
      href: "/(tabs)/approvals/req_1",
    });
  });

  it("ignores query strings on deep links (identity only)", () => {
    expect(interpretClipboardOrQr("moosewave://sequence/seq7?ref=qr")).toEqual({
      kind: "entity",
      href: "/(tabs)/sequences/seq7",
    });
  });

  it("treats an unknown action as not-an-entity (falls through to unknown)", () => {
    expect(interpretClipboardOrQr("moosewave://widget/123")).toEqual({
      kind: "unknown",
    });
  });

  it("rejects unsafe ids (path traversal) and falls through", () => {
    expect(interpretClipboardOrQr("moosewave://campaign/../etc")).toEqual({
      kind: "unknown",
    });
  });

  it("uses conversation UUID semantics and rejects the legacy ticket action", () => {
    expect(
      interpretClipboardOrQr(
        `moosewave://helpdesk-conversation/${CONVERSATION_ID}`,
      ),
    ).toEqual({
      kind: "entity",
      href: `/(tabs)/helpdesk/${CONVERSATION_ID}`,
    });
    expect(
      interpretClipboardOrQr(`moosewave://helpdesk-ticket/${CONVERSATION_ID}`),
    ).toEqual({ kind: "unknown" });
    expect(
      interpretClipboardOrQr("moosewave://helpdesk-conversation/ticket_123"),
    ).toEqual({ kind: "unknown" });
  });
});

describe("interpretClipboardOrQr — entity (universal/app links)", () => {
  it("maps an app.moosewave.com universal link to the mobile route", () => {
    expect(
      interpretClipboardOrQr("https://app.moosewave.com/app/campaigns/c42"),
    ).toEqual({ kind: "entity", href: "/(tabs)/campaigns/c42" });
  });

  it("maps a subscriber universal link to its detail route", () => {
    expect(
      interpretClipboardOrQr("https://app.moosewave.com/app/subscribers/s1"),
    ).toEqual({ kind: "entity", href: "/(tabs)/subscribers/s1" });
  });

  it("does NOT treat a non-canonical host as a Moosewave entity (it's a plain url)", () => {
    expect(
      interpretClipboardOrQr("https://evil.example.com/app/campaigns/c42"),
    ).toEqual({
      kind: "url",
      url: "https://evil.example.com/app/campaigns/c42",
    });
  });

  it("rejects http:// app links as entities (anti-spoofing) — stays a url", () => {
    const v = "http://app.moosewave.com/app/campaigns/c42";
    expect(interpretClipboardOrQr(v)).toEqual({ kind: "url", url: v });
  });
});

describe("interpretClipboardOrQr — email", () => {
  it("recognises a bare email", () => {
    expect(interpretClipboardOrQr("jane@example.com")).toEqual({
      kind: "email",
      email: "jane@example.com",
    });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(interpretClipboardOrQr("  bob@moosewave.com \n")).toEqual({
      kind: "email",
      email: "bob@moosewave.com",
    });
  });

  it("recognises a mailto: URI and strips the scheme + query", () => {
    expect(
      interpretClipboardOrQr("mailto:lead@acme.io?subject=Hi%20there"),
    ).toEqual({ kind: "email", email: "lead@acme.io" });
  });

  it("does not treat a string without a dotted domain as email", () => {
    // No TLD dot → not a confident email → unknown.
    expect(interpretClipboardOrQr("jane@localhost")).toEqual({
      kind: "unknown",
    });
  });
});

describe("interpretClipboardOrQr — url", () => {
  it("recognises an arbitrary https url", () => {
    expect(interpretClipboardOrQr("https://example.com/path?x=1")).toEqual({
      kind: "url",
      url: "https://example.com/path?x=1",
    });
  });

  it("recognises an http url", () => {
    expect(interpretClipboardOrQr("http://example.com")).toEqual({
      kind: "url",
      url: "http://example.com",
    });
  });

  it("does not treat a non-http scheme as a url", () => {
    expect(interpretClipboardOrQr("ftp://example.com/file")).toEqual({
      kind: "unknown",
    });
  });
});

describe("interpretClipboardOrQr — unknown / guards", () => {
  it("returns unknown for null / undefined / non-string", () => {
    expect(interpretClipboardOrQr(null)).toEqual({ kind: "unknown" });
    expect(interpretClipboardOrQr(undefined)).toEqual({ kind: "unknown" });
    expect(interpretClipboardOrQr(123 as unknown as string)).toEqual({
      kind: "unknown",
    });
  });

  it("returns unknown for empty / whitespace-only input", () => {
    expect(interpretClipboardOrQr("")).toEqual({ kind: "unknown" });
    expect(interpretClipboardOrQr("   ")).toEqual({ kind: "unknown" });
  });

  it("returns unknown for plain text", () => {
    expect(interpretClipboardOrQr("hello world")).toEqual({
      kind: "unknown",
    });
  });

  it("returns unknown for an oversized payload", () => {
    expect(
      interpretClipboardOrQr("https://example.com/" + "a".repeat(5000)),
    ).toEqual({ kind: "unknown" });
  });
});
