import { describe, expect, it } from "vitest";

import {
  safeBillingRedirectURL,
  safeExternalHTTPSURL,
  safeImageURL,
  safeInvoiceDownloadURL,
  safeNextPath,
} from "@/lib/safe-navigation";

describe("safeNextPath", () => {
  it("collapses null/empty/undefined to /app", () => {
    expect(safeNextPath(null)).toBe("/app");
    expect(safeNextPath("")).toBe("/app");
  });
  it("allows /app + /app/* and preserves query string", () => {
    expect(safeNextPath("/app")).toBe("/app");
    expect(safeNextPath("/app/campaigns")).toBe("/app/campaigns");
    expect(safeNextPath("/app/campaigns?status=draft")).toBe("/app/campaigns?status=draft");
  });
  it("rejects protocol-relative + cross-origin redirects", () => {
    expect(safeNextPath("//evil.com/phish")).toBe("/app");
    expect(safeNextPath("https://evil.com")).toBe("/app");
    expect(safeNextPath("javascript:alert(1)")).toBe("/app");
  });
  it("rejects anything not starting with /app unless extraPrefixes allows it", () => {
    expect(safeNextPath("/settings")).toBe("/app");
    expect(safeNextPath("/apple")).toBe("/app");
    expect(safeNextPath("/appfoo")).toBe("/app");
    expect(safeNextPath("/app/../settings")).toBe("/app");
    expect(safeNextPath("/app\\settings")).toBe("/app");
    expect(safeNextPath("/verify-email/abc")).toBe("/app");
    expect(safeNextPath("/verify-email/abc", { extraPrefixes: ["/verify-email"] })).toBe(
      "/verify-email/abc",
    );
    expect(safeNextPath("/verify-emailish", { extraPrefixes: ["/verify-email"] })).toBe(
      "/app",
    );
    expect(
      safeNextPath("/cli/auth?user_code=BCDF-GHJK", {
        extraPrefixes: ["/cli/auth"],
      }),
    ).toBe("/cli/auth?user_code=BCDF-GHJK");
    expect(
      safeNextPath("//evil.test/cli/auth?user_code=BCDF-GHJK", {
        extraPrefixes: ["/cli/auth"],
      }),
    ).toBe("/app");
  });
  it("returns /app on decodeURIComponent failure (malformed input)", () => {
    expect(safeNextPath("/app/%E0%A4%A")).toBe("/app");
  });
});

describe("safeBillingRedirectURL", () => {
  it("allows Stripe checkout and portal URLs for the right purpose", () => {
    expect(
      safeBillingRedirectURL(
        "https://checkout.stripe.com/c/pay/cs_test_123#frag",
        "checkout",
      ),
    ).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
    expect(
      safeBillingRedirectURL("https://billing.stripe.com/p/session", "portal"),
    ).toBe("https://billing.stripe.com/p/session");
  });

  it("allows local billing fallbacks but only under /app/billing", () => {
    expect(safeBillingRedirectURL("/app/billing/upgrade?checkout=studio", "checkout")).toBe(
      "/app/billing/upgrade?checkout=studio",
    );
    expect(
      safeBillingRedirectURL(
        "http://localhost:3333/app/billing?portal=local",
        "portal",
        "https://app.moosewave.com",
      ),
    ).toBe("http://localhost:3333/app/billing?portal=local");
  });

  it("rejects arbitrary, credentialed, and cross-purpose redirects", () => {
    expect(safeBillingRedirectURL("javascript:alert(1)", "checkout")).toBeNull();
    expect(
      safeBillingRedirectURL("https://user:pass@checkout.stripe.com/c/pay/cs", "checkout"),
    ).toBeNull();
    expect(safeBillingRedirectURL("https://evil.example/checkout", "checkout")).toBeNull();
    expect(safeBillingRedirectURL("https://billing.stripe.com/p/session", "checkout")).toBeNull();
    expect(safeBillingRedirectURL("/login?next=https://evil.example", "portal")).toBeNull();
  });
});

describe("safeExternalHTTPSURL", () => {
  it("allows https URLs and strips fragments", () => {
    expect(safeExternalHTTPSURL("https://login.example.com/oauth#token")).toBe(
      "https://login.example.com/oauth",
    );
  });

  it("allows only explicitly approved relative redirects", () => {
    expect(
      safeExternalHTTPSURL("/migrations/oauth/callback?code=mock", [
        "/migrations/oauth/callback",
      ]),
    ).toBe("/migrations/oauth/callback?code=mock");
    expect(safeExternalHTTPSURL("/login", ["/migrations/oauth/callback"])).toBeNull();
  });

  it("rejects unsafe schemes and credentialed URLs", () => {
    expect(safeExternalHTTPSURL("http://login.example.com/oauth")).toBeNull();
    expect(safeExternalHTTPSURL("javascript:alert(1)")).toBeNull();
    expect(safeExternalHTTPSURL("https://u:p@login.example.com/oauth")).toBeNull();
  });

  // The relative branch used a bare startsWith, so a sibling path that merely
  // shared a textual prefix satisfied the allow-list. Match on segment
  // boundaries like safeNextPath does.
  it("matches relative prefixes on a segment boundary, not by text prefix", () => {
    const allowed = ["/migrations/oauth/callback"];
    expect(safeExternalHTTPSURL("/migrations/oauth/callback", allowed)).toBe(
      "/migrations/oauth/callback",
    );
    expect(
      safeExternalHTTPSURL("/migrations/oauth/callback/step", allowed),
    ).toBe("/migrations/oauth/callback/step");
    expect(
      safeExternalHTTPSURL("/migrations/oauth/callbackEVIL", allowed),
    ).toBeNull();
  });

  it("rejects traversal and control characters in relative redirects", () => {
    const allowed = ["/migrations/oauth/callback"];
    expect(
      safeExternalHTTPSURL("/migrations/oauth/callback/../../evil", allowed),
    ).toBeNull();
    expect(
      safeExternalHTTPSURL("/migrations/oauth/callback\\evil", allowed),
    ).toBeNull();
    // Escaped NUL, not a literal control byte embedded in this source file.
    expect(
      safeExternalHTTPSURL("/migrations/oauth/callback\u0000", allowed),
    ).toBeNull();
  });

  it("trims surrounding whitespace before matching", () => {
    const allowed = ["/migrations/oauth/callback"];
    // Documented behaviour: raw.trim() runs first, so padding is stripped and
    // the trimmed path is returned rather than treated as a mismatch.
    expect(safeExternalHTTPSURL("  /migrations/oauth/callback  ", allowed)).toBe(
      "/migrations/oauth/callback",
    );
  });
});

describe("safeInvoiceDownloadURL", () => {
  it("allows Stripe-hosted invoice URLs and strips fragments", () => {
    expect(safeInvoiceDownloadURL("https://invoice.stripe.com/i/in_123#token")).toBe(
      "https://invoice.stripe.com/i/in_123",
    );
    expect(safeInvoiceDownloadURL("https://pay.stripe.com/invoice/in_123/pdf")).toBe(
      "https://pay.stripe.com/invoice/in_123/pdf",
    );
  });

  it("rejects non-Stripe, credentialed, and non-https invoice URLs", () => {
    expect(safeInvoiceDownloadURL("https://example.com/invoice.pdf")).toBeNull();
    expect(safeInvoiceDownloadURL("https://u:p@invoice.stripe.com/i/in_123")).toBeNull();
    expect(safeInvoiceDownloadURL("http://invoice.stripe.com/i/in_123")).toBeNull();
    expect(safeInvoiceDownloadURL("#")).toBeNull();
  });
});

describe("safeImageURL", () => {
  it("allows https and local development image URLs", () => {
    expect(safeImageURL("https://cdn.moosewave.com/render.png#secret")).toBe(
      "https://cdn.moosewave.com/render.png",
    );
    expect(safeImageURL("http://localhost:3001/render.png")).toBe(
      "http://localhost:3001/render.png",
    );
  });

  it("rejects unsafe image URLs", () => {
    expect(safeImageURL("http://cdn.moosewave.com/render.png")).toBeNull();
    expect(safeImageURL("https://u:p@cdn.moosewave.com/render.png")).toBeNull();
    expect(safeImageURL("data:image/png;base64,abc")).toBeNull();
  });
});
