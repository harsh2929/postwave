import { describe, expect, it } from "vitest";

import {
  eventBodyBytes,
  eventBodyPreview,
  eventTypeFromHeaders,
  invalidSignatureCount,
  replayVerdict,
} from "./inboundEventPolicy";

describe("replayVerdict", () => {
  it("allows a verified event whose body is retained", () => {
    expect(replayVerdict({ signatureValid: true, bodyRetained: true })).toEqual({
      allowed: true,
    });
  });

  it("refuses an unverified event and says why replaying it is dangerous", () => {
    const verdict = replayVerdict({
      signatureValid: false,
      bodyRetained: true,
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/signature/i);
    expect(verdict.reason).toMatch(/triggers/i);
  });

  it("puts the signature rule ahead of retention, like the server does", () => {
    const verdict = replayVerdict({
      signatureValid: false,
      bodyRetained: false,
    });
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/signature/i);
  });

  it("refuses a verified event whose payload was not retained", () => {
    const verdict = replayVerdict({
      signatureValid: true,
      bodyRetained: false,
    });
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/retained/i);
  });
});

describe("eventBodyPreview", () => {
  it("returns null for an absent body rather than an empty-looking payload", () => {
    expect(eventBodyPreview("")).toBeNull();
    expect(eventBodyPreview("   \n  ")).toBeNull();
  });

  it("collapses newlines so a pretty-printed body stays one line", () => {
    expect(eventBodyPreview('{\n  "id": 1\n}')).toBe('{ "id": 1 }');
  });

  it("truncates past the ceiling with a single ellipsis", () => {
    const preview = eventBodyPreview("x".repeat(300), 20);
    expect(preview).toHaveLength(20);
    expect(preview?.endsWith("…")).toBe(true);
  });
});

describe("eventBodyBytes", () => {
  it("is null for an absent body, never 0", () => {
    expect(eventBodyBytes("")).toBeNull();
  });

  it("measures a present body", () => {
    expect(eventBodyBytes("abcd")).toBe(4);
  });
});

describe("eventTypeFromHeaders", () => {
  it("finds a vendor event header regardless of casing", () => {
    expect(eventTypeFromHeaders({ "X-GitHub-Event": "push" })).toBe("push");
    expect(eventTypeFromHeaders({ "x-shopify-topic": "orders/create" })).toBe(
      "orders/create",
    );
  });

  it("returns null rather than inventing a type", () => {
    expect(eventTypeFromHeaders({})).toBeNull();
    expect(eventTypeFromHeaders(undefined)).toBeNull();
    expect(eventTypeFromHeaders({ "content-type": "application/json" })).toBeNull();
  });

  it("ignores blank header values", () => {
    expect(eventTypeFromHeaders({ "X-GitHub-Event": "   " })).toBeNull();
  });
});

describe("invalidSignatureCount", () => {
  it("is null when nothing has arrived — absence is not zero", () => {
    expect(invalidSignatureCount([])).toBeNull();
  });

  it("counts only the failures", () => {
    expect(
      invalidSignatureCount([
        { signatureValid: true },
        { signatureValid: false },
        { signatureValid: false },
      ]),
    ).toBe(2);
  });
});
