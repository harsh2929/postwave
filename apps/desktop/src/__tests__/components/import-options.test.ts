import { describe, expect, it } from "vitest";

import {
  IMPORT_CONSENT_CONFIRMATION,
  buildImportConsentPatch,
  emptyImportConsentDraft,
  importConsentDraftFromContract,
  validateImportConsentDraft,
  type ImportConsentDraft,
} from "../../components/subscribers/consent-evidence";
import {
  MAX_IMPORT_TAGS,
  MAX_TAG_BYTES,
  MAX_TAG_LENGTH,
  addTags,
  buildImportOptionsPatch,
  buildMappingPatch,
  importPreflightIsFresh,
  mappingPatchError,
  propertyCandidatesFromMapping,
} from "../../components/subscribers/import-options";

const NOW = Date.parse("2026-07-19T12:00:00Z");

function verifiedConsent(
  overrides: Partial<ImportConsentDraft> = {},
): ImportConsentDraft {
  return {
    mode: "verified",
    source: "double_optin",
    sourceUrl: "https://consent.example.test/records/CONSENT-123",
    capturedAtLocal: "2026-07-18T09:30",
    jurisdiction: "US-CA",
    reason: "Verified against the governed acquisition receipt.",
    policyVersion: "marketing-consent-2026-07",
    evidenceReference: "receipt:CONSENT-123",
    scopeAcknowledged: true,
    typedConfirmation: IMPORT_CONSENT_CONFIRMATION,
    ...overrides,
  };
}

describe("subscriber-import consent contract", () => {
  it("defaults to no proof and emits only the atomic negative acknowledgement", () => {
    expect(emptyImportConsentDraft()).toMatchObject({
      mode: "none",
      scopeAcknowledged: false,
      typedConfirmation: "",
    });
    expect(buildImportConsentPatch(emptyImportConsentDraft(), NOW)).toEqual({
      consent_scope_acknowledged: false,
    });
  });

  it("emits the complete, normalized positive tuple only after exact acknowledgement", () => {
    expect(buildImportConsentPatch(verifiedConsent(), NOW)).toEqual({
      consent_scope_acknowledged: true,
      consent_source: "double_optin",
      consent_source_url:
        "https://consent.example.test/records/CONSENT-123",
      consent_captured_at: new Date("2026-07-18T09:30").toISOString(),
      consent_legal_basis: "consent",
      consent_jurisdiction: "US-CA",
      consent_reason: "Verified against the governed acquisition receipt.",
      consent_policy_version: "marketing-consent-2026-07",
      consent_evidence_reference: "receipt:CONSENT-123",
      consent_scope: "email_marketing",
    });
  });

  it.each([
    ["unreviewed source", { source: "csv" as never }, "source"],
    ["HTTP evidence", { sourceUrl: "http://example.test/receipt" }, "sourceUrl"],
    ["URL credentials", { sourceUrl: "https://user:pass@example.test/r" }, "sourceUrl"],
    ["secret query", { sourceUrl: "https://example.test/r?access_token=x" }, "sourceUrl"],
    ["future timestamp", { capturedAtLocal: "2026-07-20T09:30" }, "capturedAtLocal"],
    ["bad jurisdiction", { jurisdiction: "US CA" }, "jurisdiction"],
    ["PII reason", { reason: "Approved for ada@example.test" }, "reason"],
    ["raw evidence", { evidenceReference: "ada@example.test" }, "evidenceReference"],
    ["missing scope check", { scopeAcknowledged: false }, "scopeAcknowledged"],
    ["wrong typed scope", { typedConfirmation: "EMAIL" }, "typedConfirmation"],
  ])("rejects %s", (_label, override, field) => {
    const errors = validateImportConsentDraft(
      verifiedConsent(override as Partial<ImportConsentDraft>),
      NOW,
    );
    expect(errors).toHaveProperty(field);
    expect(
      buildImportConsentPatch(
        verifiedConsent(override as Partial<ImportConsentDraft>),
        NOW,
      ),
    ).toBeNull();
  });

  it("turns incomplete legacy metadata into a no-proof repair draft", () => {
    expect(
      importConsentDraftFromContract({
        consent_contract_state: "incomplete",
        consent_source: "single_optin",
        consent_source_url: "https://example.test/old",
      }),
    ).toEqual(emptyImportConsentDraft());
  });

  it("hydrates a complete server tuple without changing its instant", () => {
    const hydrated = importConsentDraftFromContract({
      consent_contract_state: "complete",
      consent_source: "signed_form",
      consent_source_url: "https://example.test/forms/42",
      consent_captured_at: "2026-07-18T09:30:00Z",
      consent_jurisdiction: "GB",
      consent_reason: "Signed acquisition form reviewed.",
      consent_policy_version: "v4",
      consent_evidence_reference: "form:FORM-42",
    });
    expect(hydrated).toMatchObject({
      mode: "verified",
      source: "signed_form",
      sourceUrl: "https://example.test/forms/42",
      scopeAcknowledged: true,
      typedConfirmation: IMPORT_CONSENT_CONFIRMATION,
    });
    expect(new Date(hydrated.capturedAtLocal).getTime()).toBe(
      Date.parse("2026-07-18T09:30:00Z"),
    );
  });
});

describe("subscriber-import tags and options", () => {
  it("folds comma input, trims, and deduplicates case-insensitively", () => {
    expect(addTags(["Newsletter"], " newsletter, launch ")).toEqual({
      tags: ["Newsletter", "launch"],
      error: null,
    });
  });

  it("enforces code-point, UTF-8 byte, and count caps atomically", () => {
    expect(addTags([], "x".repeat(MAX_TAG_LENGTH)).error).toBeNull();
    const multiByte = "🧭".repeat(Math.floor(MAX_TAG_BYTES / 4) + 1);
    expect(addTags(["keep"], multiByte)).toEqual({
      tags: ["keep"],
      error: expect.stringMatching(/100 characters or fewer/),
    });
    const full = Array.from({ length: MAX_IMPORT_TAGS }, (_, index) => `t${index}`);
    expect(addTags(full, "overflow")).toEqual({
      tags: full,
      error: expect.stringMatching(/at most 20/i),
    });
  });

  it("builds only skip/update/error handling and never invents consent", () => {
    expect(
      buildImportOptionsPatch(
        {
          strategy: "update",
          consent: emptyImportConsentDraft(),
          tags: ["newsletter"],
          autoCreateProperties: false,
        },
        NOW,
      ),
    ).toEqual({
      on_existing: "update",
      consent_scope_acknowledged: false,
      tags: ["newsletter"],
      auto_create_properties: false,
    });
  });
});

describe("subscriber-import mapping geometry", () => {
  const mapping = {
    path: "imports/tenant/source.csv",
    headers: ["email", "company", "legacy_status"],
    rows: 3,
    columns: [
      { index: 0, name: "email", kind: "email" as const },
      { index: 1, name: "company", kind: "custom" as const, custom_key: "company" },
      { index: 2, name: "legacy_status", kind: "ignore" as const },
    ],
  };

  it("preserves the original path, headers, row count, names, and contiguous indexes", () => {
    expect(buildMappingPatch(mapping, mapping.columns)).toEqual(mapping);
    expect(mappingPatchError(mapping, mapping.columns)).toBeNull();
  });

  it("rejects gapped indexes, renamed headers, duplicate targets, and status claims", () => {
    expect(
      mappingPatchError(mapping, [mapping.columns[0], mapping.columns[2]]),
    ).toMatch(/mapping is incomplete/i);
    expect(
      mappingPatchError(mapping, [
        mapping.columns[0],
        { ...mapping.columns[1], name: "renamed" },
        mapping.columns[2],
      ]),
    ).toMatch(/header/i);
    expect(
      mappingPatchError(mapping, [
        mapping.columns[0],
        { ...mapping.columns[1], kind: "email", custom_key: undefined },
        mapping.columns[2],
      ]),
    ).toMatch(/one Email/i);
    expect(
      mappingPatchError(mapping, [
        mapping.columns[0],
        mapping.columns[1],
        { ...mapping.columns[2], kind: "status" as never },
      ]),
    ).toMatch(/resolve invalid/i);
  });

  it("offers auto-create only for explicit canonical custom keys", () => {
    expect(
      propertyCandidatesFromMapping({
        columns: [
          { name: "Name", kind: "name" },
          { name: "Company", kind: "custom" },
          { name: "Plan", kind: "custom", custom_key: "plan_tier" },
          { name: "Again", kind: "custom", custom_key: "plan_tier" },
        ],
      }),
    ).toEqual(["plan_tier"]);
  });
});

describe("preflight freshness", () => {
  const result = {
    authoritative: true as const,
    validated_at: "2026-07-19T11:55:00Z",
    expires_at: "2026-07-19T12:10:00Z",
    preflight_fingerprint: "a".repeat(64),
    state_fingerprint: "b".repeat(64),
    catalog_fingerprint: "c".repeat(64),
  };

  it("accepts only current authoritative fingerprint evidence", () => {
    expect(importPreflightIsFresh(result as never, NOW)).toBe(true);
    expect(importPreflightIsFresh({ ...result, expires_at: "2026-07-19T12:00:00Z" } as never, NOW)).toBe(false);
    expect(importPreflightIsFresh({ ...result, preflight_fingerprint: "short" } as never, NOW)).toBe(false);
  });
});
