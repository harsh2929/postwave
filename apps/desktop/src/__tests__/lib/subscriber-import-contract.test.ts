import { describe, expect, it } from "vitest";

import {
  parseSubscriberImportCancelResponse,
  parseSubscriberImportClosedEvent,
  parseSubscriberImportConfirmResponse,
  parseSubscriberImportHeartbeatEvent,
  parseSubscriberImportPatchResponse,
  parseSubscriberImportPreview,
  parseSubscriberImportProgressEvent,
  parseSubscriberImportRemapOptions,
  parseSubscriberImportResource,
} from "../../lib/api/subscriber-import-contract";

const ID = "018f07e2-7b1a-7000-8000-000000000001";
const SOURCE = "a".repeat(64);
const PREFLIGHT = "b".repeat(64);
const STATE = "c".repeat(64);
const CATALOG = "d".repeat(64);

const mapping = {
  path: "imports/tenant/source.csv",
  headers: ["email", "company"],
  columns: [
    { index: 0, name: "email", kind: "email" },
    { index: 1, name: "company", kind: "custom", custom_key: "company" },
  ],
  rows: 2,
};

function preview(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    status: "preview",
    mapping,
    sample_rows: [{ email: "a@example.test", company: "Moosewave" }],
    rows_total: 2,
    rows_new: 2,
    rows_existing: 0,
    rows_file_dupes: 0,
    on_existing: "skip",
    classification_authoritative: false,
    upload_classification_exact: true,
    source_fingerprint: SOURCE,
    source_fingerprint_scheme: "hmac-sha256-v1",
    source_fingerprint_key_version: "k2026_07",
    preflight_required: true,
    configuration_revision: 0,
    sample_values_truncated: false,
    ...overrides,
  };
}

function resource(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    filename: "audience.csv",
    status: "preview",
    mapping,
    sample_rows: [],
    sample_values_truncated: false,
    rows_total: 2,
    rows_new: 2,
    rows_existing: 0,
    rows_file_dupes: 0,
    rows_imported: 0,
    rows_skipped: 0,
    rows_failed: 0,
    processed_rows: 0,
    cancel_requested: false,
    last_chunk_at: "",
    on_existing: "skip",
    error_code: "",
    error: "",
    created_at: "2026-07-19T09:00:00.123456Z",
    configuration_revision: 1,
    consent_source: "",
    consent_source_url: "",
    consent_captured_at: "",
    consent_legal_basis: "",
    consent_jurisdiction: "",
    consent_reason: "",
    consent_policy_version: "",
    consent_evidence_reference: "",
    consent_scope: "",
    consent_scope_acknowledged: false,
    consent_contract_version: "subscriber-import-consent/v1",
    consent_contract_state: "none",
    source_fingerprint: SOURCE,
    source_fingerprint_scheme: "hmac-sha256-v1",
    source_fingerprint_key_version: "k2026_07",
    tags: [],
    auto_create_properties: false,
    schedule_type: "immediate",
    schedule_cron: "",
    scheduled_at: "",
    next_scheduled_at: "",
    drip_hours_interval: 0,
    drip_hours_total: 0,
    dry_run: false,
    dry_run_at: "",
    classification_authoritative: false,
    preflight_required: true,
    preflight_fingerprint: "",
    preflight_at: "",
    preflight_expires_at: "",
    preflight_rows_total: null,
    preflight_rows_failed: 0,
    preflight_rows_existing: 0,
    preflight_state_fingerprint: "",
    preflight_catalog_fingerprint: "",
    execution_state_fingerprint: "",
    confirmed_consent_fingerprint: "",
    rows_sendable_after: 0,
    rows_protected_existing: 0,
    consent_receipts_written: 0,
    existing_contact_eligibility_policy: "preserve",
    ...overrides,
  };
}

function dryRunResults() {
  return {
    rows_total: 2,
    would_create: 2,
    would_update: 0,
    would_skip: 0,
    would_fail: 0,
    file_dupes: 0,
    rows: [
      { row_number: 1, outcome: "create" },
      { row_number: 2, outcome: "create" },
    ],
    detail_capped: false,
    validated_at: "2026-07-19T10:00:00Z",
    authoritative: true,
    preflight_fingerprint: PREFLIGHT,
    would_be_sendable: 0,
    would_remain_protected: 0,
    consent_contract_state: "none",
    state_fingerprint: STATE,
    catalog_fingerprint: CATALOG,
    expires_at: "2026-07-19T10:15:00Z",
  };
}

describe("subscriber import strict wire parsing", () => {
  it("accepts the exact preview and rejects unknown/missing/invariant-breaking keys", () => {
    expect(parseSubscriberImportPreview(preview())).not.toBeNull();
    expect(parseSubscriberImportPreview(preview({ unexpected: true }))).toBeNull();
    const { source_fingerprint: _removed, ...missing } = preview();
    expect(parseSubscriberImportPreview(missing)).toBeNull();
    expect(
      parseSubscriberImportPreview(preview({ classification_authoritative: true })),
    ).toBeNull();
    expect(
      parseSubscriberImportPreview(preview({ source_fingerprint_key_version: "bad/key" })),
    ).toBeNull();
  });

  it("enforces the 256-byte preview-cell boundary even for multi-byte text", () => {
    expect(
      parseSubscriberImportPreview(
        preview({ sample_rows: [{ company: "🧭".repeat(64) }] }),
      ),
    ).not.toBeNull();
    expect(
      parseSubscriberImportPreview(
        preview({ sample_rows: [{ company: "🧭".repeat(65) }] }),
      ),
    ).toBeNull();
  });

  it("enforces bounded source geometry and aggregate retained sample bytes", () => {
    const headers = Array.from({ length: 128 }, (_, index) => `column_${index}`);
    const wideMapping = {
      path: mapping.path,
      headers,
      columns: headers.map((name, index) => ({
        index,
        name,
        kind: index === 0 ? "email" : "ignore",
      })),
      rows: 2,
    };
    const sample = Object.fromEntries(headers.map((header) => [header, "x".repeat(256)]));
    expect(
      parseSubscriberImportPreview(
        preview({ mapping: wideMapping, sample_rows: [sample] }),
      ),
    ).toBeNull();
    expect(
      parseSubscriberImportPreview(
        preview({
          mapping: {
            ...mapping,
            headers: ["email", "🧭".repeat(257)],
            columns: [
              { index: 0, name: "email", kind: "email" },
              { index: 1, name: "🧭".repeat(257), kind: "ignore" },
            ],
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects impossible preview classifications", () => {
    expect(parseSubscriberImportPreview(preview({ rows_new: 3 }))).toBeNull();
    expect(parseSubscriberImportPreview(preview({ rows_file_dupes: 3 }))).toBeNull();
    expect(
      parseSubscriberImportPreview(
        preview({ mapping: { ...mapping, rows: 3 } }),
      ),
    ).toBeNull();
  });

  it("accepts the exact GET resource, including repairable legacy incomplete consent", () => {
    expect(parseSubscriberImportResource(resource())).not.toBeNull();
    expect(
      parseSubscriberImportResource(
        resource({
          consent_contract_state: "incomplete",
          consent_source: "single_optin",
          consent_contract_version: "",
        }),
      )?.consent_contract_state,
    ).toBe("incomplete");
    expect(parseSubscriberImportResource(resource({ extra: 1 }))).toBeNull();
    expect(
      parseSubscriberImportResource(resource({ consent_contract_version: "" })),
    ).toBeNull();
  });

  it("rejects unsafe filenames and non-normalized persisted tags", () => {
    expect(parseSubscriberImportResource(resource({ filename: "../audience.csv" }))).toBeNull();
    expect(
      parseSubscriberImportResource(resource({ filename: "audience\u202erev.csv" })),
    ).toBeNull();
    expect(parseSubscriberImportResource(resource({ tags: ["vip", "VIP"] }))).toBeNull();
    expect(parseSubscriberImportResource(resource({ tags: [" vip"] }))).toBeNull();
    expect(
      parseSubscriberImportResource(resource({ tags: ["🧭".repeat(101)] })),
    ).toBeNull();
  });

  it("cross-checks retained dry-run evidence against the GET provenance", () => {
    const results = dryRunResults();
    const exact = resource({
      dry_run: true,
      dry_run_at: results.validated_at,
      classification_authoritative: true,
      preflight_required: false,
      preflight_fingerprint: PREFLIGHT,
      preflight_at: results.validated_at,
      preflight_expires_at: results.expires_at,
      preflight_rows_total: 2,
      preflight_state_fingerprint: STATE,
      preflight_catalog_fingerprint: CATALOG,
      dry_run_results: results,
    });
    expect(parseSubscriberImportResource(exact)?.dry_run_results).toEqual(results);
    expect(
      parseSubscriberImportResource({
        ...exact,
        preflight_catalog_fingerprint: "e".repeat(64),
      }),
    ).toBeNull();
  });

  it("pins conditional PATCH, confirm, and cancellation response shapes", () => {
    expect(
      parseSubscriberImportPatchResponse({
        id: ID,
        status: "preview",
        updated: true,
        configuration_revision: 2,
        preflight_required: true,
      }),
    ).not.toBeNull();
    expect(
      parseSubscriberImportPatchResponse({
        id: ID,
        status: "preview",
        updated: false,
        configuration_revision: 2,
      }),
    ).not.toBeNull();
    expect(
      parseSubscriberImportPatchResponse({
        id: ID,
        status: "preview",
        updated: false,
        configuration_revision: 2,
        preflight_required: true,
      }),
    ).toBeNull();
    expect(
      parseSubscriberImportConfirmResponse({
        id: ID,
        status: "preview",
        dry_run: true,
        dry_run_results: dryRunResults(),
      }),
    ).not.toBeNull();
    expect(
      parseSubscriberImportConfirmResponse({
        id: ID,
        status: "queued",
        preflight_fingerprint: PREFLIGHT,
        classification_authoritative: true,
        consent_contract_state: "none",
        scheduled: true,
      }),
    ).toBeNull();
    expect(
      parseSubscriberImportConfirmResponse({
        id: ID,
        status: "queued",
        preflight_fingerprint: PREFLIGHT,
        classification_authoritative: true,
        consent_contract_state: "none",
        scheduled: true,
        next_scheduled_at: "2026-07-19T11:00:00Z",
      }),
    ).not.toBeNull();
    expect(
      parseSubscriberImportCancelResponse({
        id: ID,
        status: "cancelled",
        cancel_requested: true,
      }),
    ).not.toBeNull();
  });

  it("rejects impossible progress and strictly parses stream control events", () => {
    expect(
      parseSubscriberImportProgressEvent({
        status: "running",
        processed_rows: 2,
        total_rows: 4,
        rows_imported: 1,
        rows_skipped: 1,
        rows_failed: 0,
      }),
    ).not.toBeNull();
    expect(
      parseSubscriberImportProgressEvent({
        status: "running",
        processed_rows: 1,
        total_rows: 4,
        rows_imported: 1,
        rows_skipped: 1,
        rows_failed: 0,
      }),
    ).toBeNull();
    expect(parseSubscriberImportHeartbeatEvent({ at: "2026-07-19T10:00:00Z" })).not.toBeNull();
    expect(parseSubscriberImportHeartbeatEvent({ at: "today", extra: 1 })).toBeNull();
    expect(parseSubscriberImportClosedEvent({ reason: "max_duration" })).not.toBeNull();
    expect(parseSubscriberImportClosedEvent({ reason: "server_error" })).toBeNull();
  });

  it("enumerates every supported custom-field type and rejects additions", () => {
    const types = [
      "string",
      "number",
      "boolean",
      "date",
      "enum",
      "array",
      "object",
      "email",
      "url",
      "phone",
      "region",
    ];
    expect(
      parseSubscriberImportRemapOptions({
        merge_fields: [
          { kind: "email", label: "Email" },
          { kind: "name", label: "Name" },
          { kind: "tags", label: "Tags" },
          { kind: "custom", label: "Custom field" },
          { kind: "ignore", label: "Ignore" },
        ],
        custom_fields: types.map((type, index) => ({
          key: `field_${index}`,
          label: `Field ${index}`,
          type,
        })),
      })?.custom_fields,
    ).toHaveLength(types.length);
    expect(
      parseSubscriberImportRemapOptions({
        merge_fields: [
          { kind: "email", label: "Email" },
          { kind: "name", label: "Name" },
          { kind: "tags", label: "Tags" },
          { kind: "custom", label: "Custom field" },
          { kind: "ignore", label: "Ignore" },
        ],
        custom_fields: [{ key: "company", label: "Company", type: "xml" }],
      }),
    ).toBeNull();
    expect(
      parseSubscriberImportRemapOptions({
        merge_fields: [
          { kind: "email", label: "Email" },
          { kind: "ignore", label: "Ignore" },
        ],
        custom_fields: [],
      }),
    ).toBeNull();
  });
});
