import { describe, expect, it } from "vitest";

import {
  looksLikeObviousRawCredential,
  parseNativeProviderRegistry,
  RAW_CREDENTIAL_REFERENCE_ERROR,
  validateNativeProviderDraft,
} from "../../pages/integrations/native-provider-form";

describe("native provider credential-reference validation", () => {
  it.each([
    "vault://crm/hubspot",
    "cred_hubspot_prod",
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:postwave/crm",
    "customer-specific-reference-format",
  ])("leaves non-secret reference formats open: %s", (reference) => {
    expect(looksLikeObviousRawCredential(reference)).toBe(false);
  });

  it.each([
    "sk_live_51rawcredential",
    "Bearer pasted-provider-token",
    "eyJheader.payload.signature",
    '{"client_secret":"pasted"}',
    "-----BEGIN RSA PRIVATE KEY-----\nraw\n-----END RSA PRIVATE KEY-----",
    "x".repeat(96),
  ])("trips on an obvious pasted secret: %s", (secret) => {
    expect(looksLikeObviousRawCredential(secret)).toBe(true);
  });

  it("trims valid values and reports the first invalid field in registry order", () => {
    const result = validateNativeProviderDraft(
      [
        { key: "portal_id", label: "Portal ID", required: true },
        {
          key: "credentials_ref",
          label: "Credential reference",
          required: true,
        },
      ],
      {
        portal_id: "   ",
        credentials_ref: " sk_test_pasted-secret ",
      },
    );

    expect(result.firstInvalidKey).toBe("portal_id");
    expect(result.errors).toEqual({
      portal_id: "Portal ID is required.",
      credentials_ref: RAW_CREDENTIAL_REFERENCE_ERROR,
    });
    expect(result.cleaned).toEqual({
      credentials_ref: "sk_test_pasted-secret",
    });
  });
});

describe("native provider registry contract", () => {
  const provider = {
    provider: "hubspot",
    name: "HubSpot",
    category: "crm",
    auth_mode: "vault_reference",
    managed: true,
    runtime_status: "available",
    capabilities: ["profiles"],
    required_settings: [
      {
        key: "credentials_ref",
        label: "Secure vault reference",
        required: true,
      },
    ],
    optional_settings: [],
    scopes: ["crm.objects.contacts.read"],
    sync_objects: ["contacts"],
    docs_url: "https://docs.example.test/hubspot",
  };

  it("accepts bounded, unique provider metadata", () => {
    expect(parseNativeProviderRegistry({ items: [provider] })).toEqual([
      provider,
    ]);
  });

  it("rejects duplicate providers and duplicate or unbounded fields", () => {
    expect(
      parseNativeProviderRegistry({ items: [provider, provider] }),
    ).toBeNull();
    expect(
      parseNativeProviderRegistry({
        items: [
          {
            ...provider,
            required_settings: [
              provider.required_settings[0],
              provider.required_settings[0],
            ],
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseNativeProviderRegistry({
        items: [
          {
            ...provider,
            capabilities: Array.from(
              { length: 129 },
              (_, index) => `capability-${index}`,
            ),
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects malformed registry success bodies instead of rendering them", () => {
    expect(parseNativeProviderRegistry({ items: "not-an-array" })).toBeNull();
    expect(
      parseNativeProviderRegistry({
        items: [{ ...provider, managed: "yes" }],
      }),
    ).toBeNull();
  });
});
