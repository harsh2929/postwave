/**
 * provider-config-helpers — the ESP mirror-credential logic behind
 * ProviderConfigCard (close-open-loops: ESP suppression mirror credentials).
 *
 * Contract under test:
 *   • Only Mailchimp + SendGrid support suppression mirroring.
 *   • Secret STATE is derived from the redacted read (the backend hides the
 *     real value behind the literal "redacted"), never the value itself.
 *   • The sparse upsert payload never re-sends a redacted sentinel; the
 *     server-side merge contract preserves omitted stored secrets.
 */

import { describe, expect, it } from "vitest";

import {
  REDACTED_SENTINEL,
  buildUpsertConfig,
  credentialRefValidationError,
  generateSecureWebhookToken,
  isSecretSet,
  providerSecretState,
  providerSupportsMirror,
  webhookTokenValidationError,
} from "../../components/deliverability/provider-config-helpers";

describe("providerSupportsMirror", () => {
  it("is true for the ESPs with suppression mirror clients", () => {
    expect(providerSupportsMirror("mailchimp")).toBe(true);
    expect(providerSupportsMirror("sendgrid")).toBe(true);
  });

  it("is false for providers without a real suppression mirror client", () => {
    for (const p of ["ses", "mailgun", "postmark", "resend", "sparkpost"]) {
      expect(providerSupportsMirror(p)).toBe(false);
    }
  });
});

describe("webhook token security", () => {
  it("requires a strong bounded ASCII token", () => {
    expect(webhookTokenValidationError("")).toBeNull();
    expect(webhookTokenValidationError("a".repeat(32))).toBeNull();
    expect(webhookTokenValidationError("short")).toContain("32-512");
    expect(webhookTokenValidationError(`${"a".repeat(32)} space`)).toContain(
      "whitespace-free",
    );
  });

  it("generates a 256-bit lowercase hexadecimal token", () => {
    const token = generateSecureWebhookToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(generateSecureWebhookToken()).not.toBe(token);
  });
});

describe("credentialRefValidationError", () => {
  it("accepts namespaced tenant-relative runtime-secret references", () => {
    for (const ref of [
      "deliverability/sendgrid",
      "postwave/deliverability/mailchimp",
      "cred_sendgrid_mirror",
    ]) {
      expect(credentialRefValidationError(ref)).toBeNull();
    }
  });

  it("rejects raw credentials and ambiguous unnamespaced values", () => {
    for (const value of [
      "SG.raw-key",
      "Bearer token",
      "abc123-us21",
      '{"api_key":"secret"}',
      "contains whitespace",
      "tenants/another-tenant/deliverability/sendgrid",
    ]) {
      expect(credentialRefValidationError(value)).toContain(
        "do not paste an API key",
      );
    }
  });
});

describe("isSecretSet", () => {
  it("treats the redacted sentinel as 'set'", () => {
    expect(isSecretSet({ api_key: REDACTED_SENTINEL }, "api_key")).toBe(true);
  });

  it("treats a present real value as 'set'", () => {
    expect(isSecretSet({ webhook_token: "abc" }, "webhook_token")).toBe(true);
  });

  it("treats absent / empty / non-string as 'not set'", () => {
    expect(isSecretSet(undefined, "api_key")).toBe(false);
    expect(isSecretSet({}, "api_key")).toBe(false);
    expect(isSecretSet({ api_key: "" }, "api_key")).toBe(false);
    expect(isSecretSet({ api_key: "   " }, "api_key")).toBe(false);
    expect(isSecretSet({ api_key: 123 }, "api_key")).toBe(false);
  });
});

describe("providerSecretState", () => {
  it("reports webhook, vault-reference, and legacy-key state independently", () => {
    expect(
      providerSecretState({
        webhook_token: REDACTED_SENTINEL,
        credential_ref: "deliverability/sendgrid",
        api_key: REDACTED_SENTINEL,
      }),
    ).toEqual({
      webhookTokenSet: true,
      mirrorCredentialRefSet: true,
      legacyApiKeySet: true,
    });
  });

  it("reports neither for an empty/missing config", () => {
    expect(providerSecretState(undefined)).toEqual({
      webhookTokenSet: false,
      mirrorCredentialRefSet: false,
      legacyApiKeySet: false,
    });
  });
});

describe("buildUpsertConfig", () => {
  it("carries a typed webhook token and vault reference", () => {
    expect(
      buildUpsertConfig({
        existing: undefined,
        webhookTokenInput: " wh ",
        credentialRefInput: " deliverability/mailchimp ",
      }),
    ).toEqual({
      webhook_token: "wh",
      credential_ref: "deliverability/mailchimp",
    });
  });

  it("omits blank inputs", () => {
    expect(
      buildUpsertConfig({
        existing: undefined,
        webhookTokenInput: "",
        credentialRefInput: "",
      }),
    ).toEqual({});
  });

  it("defensively carries a stored real webhook token when left blank", () => {
    // Defensive: if a future backend returned a real (non-redacted) value,
    // an untouched field must not clobber it.
    expect(
      buildUpsertConfig({
        existing: { webhook_token: "real-tok", api_key: "real-key-us21" },
        webhookTokenInput: "",
        credentialRefInput: "deliverability/sendgrid",
      }),
    ).toEqual({
      webhook_token: "real-tok",
      credential_ref: "deliverability/sendgrid",
    });
  });

  it("omits a redacted sentinel so the server preserves the stored secret", () => {
    // The real value is intentionally unrecoverable from the client. The
    // backend overlays this sparse payload onto stored config.
    const out = buildUpsertConfig({
      existing: {
        webhook_token: REDACTED_SENTINEL,
        api_key: REDACTED_SENTINEL,
      },
      webhookTokenInput: "",
      credentialRefInput: "deliverability/mailchimp",
    });
    expect(out).toEqual({
      credential_ref: "deliverability/mailchimp",
    });
    expect(out.webhook_token).toBeUndefined();
    expect(out.api_key).toBeUndefined();
  });
});
