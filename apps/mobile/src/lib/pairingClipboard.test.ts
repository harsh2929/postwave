import { describe, expect, it } from "vitest";

import { interpretPairingPaste, pairingPasteMessage } from "./pairingClipboard";

describe("interpretPairingPaste", () => {
  it("recognises a live key and strips the newline a copy leaves behind", () => {
    expect(interpretPairingPaste("  pw_live_abcdef0123456789\n")).toEqual({
      kind: "apiKey",
      apiKey: "pw_live_abcdef0123456789",
    });
  });

  it("recognises a test key", () => {
    expect(interpretPairingPaste("pw_test_ABCDEF-0123_456789").kind).toBe(
      "apiKey",
    );
  });

  it("routes a server URL to the base-URL field, without its trailing slash", () => {
    expect(interpretPairingPaste("https://mail.acme.internal/")).toEqual({
      kind: "baseUrl",
      baseUrl: "https://mail.acme.internal",
    });
  });

  it("refuses a URL that could carry a credential somewhere else", () => {
    for (const bad of [
      "https://user:pw@api.moosewave.com",
      "https://api.moosewave.com?token=abc",
      "https://api.moosewave.com#tok",
      "javascript:alert(1)",
      "ftp://api.moosewave.com",
    ]) {
      expect(interpretPairingPaste(bad).kind).toBe("none");
    }
  });

  it("does not claim arbitrary clipboard content as a credential", () => {
    for (const bad of [
      "",
      "   ",
      "the quick brown fox",
      "pw_",
      "pw_short",
      "PW_LIVE_ABCDEF0123",
      `pw_live_${"a".repeat(500)}`,
    ]) {
      expect(interpretPairingPaste(bad).kind).toBe("none");
    }
    expect(interpretPairingPaste(null).kind).toBe("none");
    expect(interpretPairingPaste(undefined).kind).toBe("none");
  });

  it("separates an empty clipboard from an unrecognised one", () => {
    expect(interpretPairingPaste("")).toEqual({ kind: "none", reason: "empty" });
    expect(interpretPairingPaste("nonsense")).toEqual({
      kind: "none",
      reason: "unrecognised",
    });
  });
});

describe("pairingPasteMessage", () => {
  it("names what the clipboard actually held", () => {
    expect(pairingPasteMessage(interpretPairingPaste("pw_live_abcdef0123"))).toContain(
      "API key",
    );
    expect(
      pairingPasteMessage(interpretPairingPaste("https://api.moosewave.com")),
    ).toContain("API base URL");
    expect(pairingPasteMessage(interpretPairingPaste(""))).toContain("empty");
    expect(pairingPasteMessage(interpretPairingPaste("junk"))).toContain("pw_");
  });
});
