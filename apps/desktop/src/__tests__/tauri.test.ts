import { describe, expect, it } from "vitest";

import {
  safeExternalAssetUrl,
  safeFormSuccessRedirectUrl,
} from "../lib/safe-url";
import { safeOpenExternalUrl } from "../lib/tauri";

describe("safeOpenExternalUrl", () => {
  it("allows https, mailto, and local dev http URLs", () => {
    expect(safeOpenExternalUrl("https://app.moosewave.com/path#token")).toBe(
      "https://app.moosewave.com/path",
    );
    expect(safeOpenExternalUrl("mailto:privacy@moosewave.com")).toBe(
      "mailto:privacy@moosewave.com",
    );
    expect(safeOpenExternalUrl("mailto:?subject=Hello&body=Share")).toBe(
      "mailto:?subject=Hello&body=Share",
    );
    expect(safeOpenExternalUrl("sms:?&body=Share")).toBe("sms:?&body=Share");
    expect(safeOpenExternalUrl("http://localhost:3000/app")).toBe(
      "http://localhost:3000/app",
    );
  });

  it("rejects unsafe external URLs before native open", () => {
    expect(safeOpenExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeOpenExternalUrl("file:///tmp/private.txt")).toBeNull();
    expect(safeOpenExternalUrl("http://app.moosewave.com")).toBeNull();
    expect(safeOpenExternalUrl("https://u:p@app.moosewave.com")).toBeNull();
    expect(safeOpenExternalUrl("https://app.moosewave.com/a\u0000b")).toBeNull();
    expect(safeOpenExternalUrl("https://app.moosewave.com/a\nb")).toBeNull();
    expect(safeOpenExternalUrl("not a url")).toBeNull();
    expect(safeOpenExternalUrl("mailto:attacker@example.com")).toBeNull();
    expect(
      safeOpenExternalUrl("mailto:attacker@example.com,privacy@moosewave.com"),
    ).toBeNull();
    expect(safeOpenExternalUrl("sms:12345?redirect=evil")).toBeNull();
  });
});

describe("safeExternalAssetUrl", () => {
  it("allows https and loopback image URLs", () => {
    expect(safeExternalAssetUrl("https://cdn.moosewave.com/a.png#frag")).toBe(
      "https://cdn.moosewave.com/a.png",
    );
    expect(safeExternalAssetUrl("http://127.0.0.1:8080/a.png")).toBe(
      "http://127.0.0.1:8080/a.png",
    );
  });

  it("rejects unsafe image URLs", () => {
    expect(safeExternalAssetUrl("http://example.com/a.png")).toBeNull();
    expect(safeExternalAssetUrl("https://u:p@example.com/a.png")).toBeNull();
    expect(safeExternalAssetUrl("file:///tmp/a.png")).toBeNull();
  });
});

describe("safeFormSuccessRedirectUrl", () => {
  it("allows safe form success redirects", () => {
    expect(safeFormSuccessRedirectUrl("https://example.com/thanks#frag")).toBe(
      "https://example.com/thanks",
    );
    expect(safeFormSuccessRedirectUrl("http://localhost:3000/thanks")).toBe(
      "http://localhost:3000/thanks",
    );
    expect(safeFormSuccessRedirectUrl("/thanks")).toBe("/thanks");
  });

  it("rejects unsafe form success redirects", () => {
    expect(safeFormSuccessRedirectUrl("javascript:alert(1)")).toBeNull();
    expect(
      safeFormSuccessRedirectUrl("https://u:p@example.com/thanks"),
    ).toBeNull();
    expect(safeFormSuccessRedirectUrl("//evil.example/thanks")).toBeNull();
  });
});
