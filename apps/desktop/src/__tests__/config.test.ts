import { describe, expect, it } from "vitest";

import {
  normalizeApiUrl,
  normalizeOptionalAssetBaseUrl,
  normalizeOptionalHttpsOrigin,
  normalizePublicHttpsUrl,
  validateApiUrl,
} from "../lib/config";

describe("desktop config", () => {
  it("normalizes API URLs by trimming trailing slashes", () => {
    expect(normalizeApiUrl(" https://api.moosewave.com/// ")).toBe(
      "https://api.moosewave.com",
    );
  });

  it("accepts HTTPS API URLs", () => {
    expect(validateApiUrl("https://api.moosewave.com").ok).toBe(true);
  });

  it("rejects empty/blank input instead of normalizing to the default", () => {
    for (const input of ["", "   ", null, undefined]) {
      const result = validateApiUrl(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe("API URL is required.");
      }
    }
  });

  it("rejects unsupported schemes", () => {
    const result = validateApiUrl("file:///tmp/postwave");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/http/i);
    }
  });

  it("rejects credentialed API URLs", () => {
    const result = validateApiUrl("https://user:pass@api.moosewave.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/credentials/i);
    }
  });

  it("rejects API URLs with query strings or fragments", () => {
    expect(validateApiUrl("https://api.moosewave.com?x=1").ok).toBe(false);
    expect(validateApiUrl("https://api.moosewave.com#token").ok).toBe(false);
  });

  it("normalizes public legal/support URLs before native open", () => {
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

  it("accepts only an exact credential-free HTTPS hosted-asset base", () => {
    expect(
      normalizeOptionalAssetBaseUrl(
        " https://assets.moosewave.com/hosted/// ",
      ),
    ).toBe("https://assets.moosewave.com/hosted");
    expect(
      normalizeOptionalAssetBaseUrl(
        "https://assets.moosewave.com/hosted?token=secret",
      ),
    ).toBeNull();
    expect(
      normalizeOptionalAssetBaseUrl(
        "https://user:secret@assets.moosewave.com/hosted",
      ),
    ).toBeNull();
    expect(normalizeOptionalAssetBaseUrl("javascript:alert(1)")).toBeNull();
  });

  it("accepts only a credential-free HTTPS reference-preview origin", () => {
    expect(
      normalizeOptionalHttpsOrigin(
        " https://pro-really-good-emails.s3.eu-west-1.amazonaws.com/ ",
      ),
    ).toBe("https://pro-really-good-emails.s3.eu-west-1.amazonaws.com");
    expect(
      normalizeOptionalHttpsOrigin("https://provider.example/previews"),
    ).toBeNull();
    expect(
      normalizeOptionalHttpsOrigin("https://user:secret@provider.example"),
    ).toBeNull();
    expect(normalizeOptionalHttpsOrigin("http://provider.example")).toBeNull();
  });
});
