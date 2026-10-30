import { describe, expect, it } from "vitest";

import {
  normalizeApiBaseUrl,
  normalizeExternalAppUrl,
  normalizePublicHttpsUrl,
  validateApiBaseUrl,
} from "./config";

describe("mobile config", () => {
  it("normalizes API base URLs without changing the scheme or host", () => {
    expect(normalizeApiBaseUrl(" https://api.example.com/// ")).toBe(
      "https://api.example.com",
    );
  });

  it("allows HTTP only for SDK-supported loopback development hosts", () => {
    expect(validateApiBaseUrl("http://localhost:8080", "development")).toEqual({
      ok: true,
      url: "http://localhost:8080",
    });
    expect(validateApiBaseUrl("http://127.0.0.1:8080", "development").ok).toBe(
      true,
    );
    expect(validateApiBaseUrl("http://[::1]:8080", "development").ok).toBe(
      true,
    );
  });

  it("ACCEPTS a LAN HTTP host in a development build", () => {
    // POLICY CHANGE (approved 2026-08-03). This previously asserted the
    // opposite. A physical device cannot satisfy the loopback rule at all —
    // `localhost` on the phone means the PHONE — so testing on real hardware
    // was impossible without a public tunnel or a self-signed cert.
    //
    // The relaxation is deliberately narrow: private-network IP LITERALS only
    // (never names, which DNS could point anywhere), and never in production.
    // Full matrix in lib/httpPrivateNetworkPolicy.test.ts.
    const result = validateApiBaseUrl(
      "http://192.168.1.50:8080",
      "development",
    );
    expect(result.ok).toBe(true);
  });

  it("still rejects a LAN HTTP host in a production build", () => {
    // The half that must never move: credentials over cleartext are acceptable
    // on a developer's own network and nowhere else.
    const result = validateApiBaseUrl(
      "http://192.168.1.50:8080",
      "production",
    );
    expect(result.ok).toBe(false);
  });

  it("still rejects a PUBLIC HTTP host in development", () => {
    const result = validateApiBaseUrl("http://api.example.com", "development");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/localhost/i);
  });

  it("rejects HTTP in production builds", () => {
    const result = validateApiBaseUrl("http://api.example.com", "production");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/HTTP|localhost/);
    }
  });

  it("rejects localhost in production builds", () => {
    const result = validateApiBaseUrl("https://localhost:8080", "production");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/local API hosts/);
    }
  });

  it("rejects credentialed API base URLs", () => {
    const result = validateApiBaseUrl("https://user:pass@api.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/credentials/i);
    }
  });

  it("rejects API base URLs with query strings or fragments", () => {
    expect(validateApiBaseUrl("https://api.example.com?x=1").ok).toBe(false);
    expect(validateApiBaseUrl("https://api.example.com#token").ok).toBe(false);
  });

  it("rejects control characters in URLs before opening or saving", () => {
    expect(validateApiBaseUrl("https://api.example.com\nx").ok).toBe(false);
    expect(
      normalizePublicHttpsUrl(
        "https://moosewave.com/legal/privacy\nx",
        "https://fallback",
      ),
    ).toBe("https://fallback");
    expect(
      normalizeExternalAppUrl("https://app.moosewave.com/archive/a\nx"),
    ).toBeNull();
  });

  it("normalizes public legal/support URLs before Linking.openURL", () => {
    expect(
      normalizePublicHttpsUrl(
        "https://moosewave.com/legal/privacy#x",
        "https://fallback",
      ),
    ).toBe("https://moosewave.com/legal/privacy");
    expect(
      normalizePublicHttpsUrl(
        "https://u:p@moosewave.com/legal/privacy",
        "https://fallback",
      ),
    ).toBe("https://fallback");
    expect(
      normalizePublicHttpsUrl("javascript:alert(1)", "https://fallback"),
    ).toBe("https://fallback");
  });

  it("normalizes app-owned external URLs before Linking.openURL", () => {
    expect(
      normalizeExternalAppUrl("https://app.moosewave.com/archive/a#x"),
    ).toBe("https://app.moosewave.com/archive/a");
    expect(
      normalizeExternalAppUrl("https://u:p@app.moosewave.com/archive/a"),
    ).toBeNull();
    expect(normalizeExternalAppUrl("javascript:alert(1)")).toBeNull();
  });
});
