import { describe, expect, it } from "vitest";

import {
  MIGRATION_DISCOVERY_WIRE_LIMITS,
  parseMigrationDiscoveryReport,
  parseMigrationDryRunAcknowledgement,
} from "../../lib/api/migrations";

function validDiscovery(): Record<string, unknown> {
  return {
    job_id: "job_1",
    source: "mailchimp",
    subscribers_count: 12,
    segments_count: 3,
    automations_count: 2,
    archive_count: 4,
    paid_subs_count: 0,
    templates_count: 7,
    custom_fields: ["first_name"],
    warnings: ["One archived workflow requires review."],
    audiences: [{ id: "aud_1", name: "Main", subscribers_total: 12 }],
    capabilities: { source: "mailchimp" },
    resource_metadata: { ignored: true },
  };
}

function expectDiscoveryParseError(
  value: unknown,
  code = "migration_discovery_invalid_response",
): void {
  const result = parseMigrationDiscoveryReport(value, {
    source: "mailchimp",
    jobId: "job_1",
  });
  if (!result.error) throw new Error("expected discovery parse failure");
  expect(result.data).toBeUndefined();
  expect(result.error).toEqual({
    kind: "parse",
    code,
    message: "The migration discovery response could not be verified.",
  });
  expect(result.retryability).toBe("manual");
}

describe("migration discovery wire decoder", () => {
  it("projects a valid identity-bound response into a fresh bounded report", () => {
    const value = validDiscovery();
    const result = parseMigrationDiscoveryReport(value, {
      source: "mailchimp",
      jobId: "job_1",
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({
      job_id: "job_1",
      source: "mailchimp",
      subscribers_count: 12,
      segments_count: 3,
      automations_count: 2,
      archive_count: 4,
      paid_subs_count: 0,
      templates_count: 7,
      custom_fields: ["first_name"],
      warnings: ["One archived workflow requires review."],
      audiences: [{ id: "aud_1", name: "Main", subscribers_total: 12 }],
    });
    expect(result.data).not.toBe(value);
    expect(result.data?.audiences).not.toBe(value.audiences);
    expect(result.data).not.toHaveProperty("capabilities");
    expect(result.data).not.toHaveProperty("resource_metadata");
  });

  it.each([null, undefined, [], "invalid", 1, true])(
    "fails closed for a non-object discovery envelope: %j",
    (value) => {
      expectDiscoveryParseError(value);
    },
  );

  it.each([
    ["missing job", { ...validDiscovery(), job_id: undefined }],
    ["wrong job", { ...validDiscovery(), job_id: "job_2" }],
    ["wrong source", { ...validDiscovery(), source: "klaviyo" }],
    ["non-string source", { ...validDiscovery(), source: null }],
  ])("rejects %s identity", (_label, value) => {
    expectDiscoveryParseError(
      value,
      "migration_discovery_identity_mismatch",
    );
  });

  it.each([
    ["null audience", [null]],
    ["non-object audience", ["aud_1"]],
    ["missing audience id", [{ subscribers_total: 1 }]],
    ["blank audience id", [{ id: " ", subscribers_total: 1 }]],
    ["non-string audience name", [{ id: "aud_1", name: 1, subscribers_total: 1 }]],
    ["missing audience count", [{ id: "aud_1" }]],
    ["fractional audience count", [{ id: "aud_1", subscribers_total: 1.5 }]],
    [
      "duplicate audience id",
      [
        { id: "aud_1", subscribers_total: 1 },
        { id: "aud_1", subscribers_total: 2 },
      ],
    ],
  ])("rejects a malformed %s", (_label, audiences) => {
    expectDiscoveryParseError({ ...validDiscovery(), audiences });
  });

  it.each([
    [
      "audience id",
      {
        audiences: [
          {
            id: "a".repeat(
              MIGRATION_DISCOVERY_WIRE_LIMITS.audienceIdLength + 1,
            ),
            subscribers_total: 1,
          },
        ],
      },
    ],
    [
      "audience name",
      {
        audiences: [
          {
            id: "aud_1",
            name: "a".repeat(
              MIGRATION_DISCOVERY_WIRE_LIMITS.audienceNameLength + 1,
            ),
            subscribers_total: 1,
          },
        ],
      },
    ],
    [
      "custom field",
      {
        custom_fields: [
          "a".repeat(MIGRATION_DISCOVERY_WIRE_LIMITS.customFieldLength + 1),
        ],
      },
    ],
    [
      "warning",
      {
        warnings: [
          "a".repeat(MIGRATION_DISCOVERY_WIRE_LIMITS.warningLength + 1),
        ],
      },
    ],
  ])("rejects an oversized %s string", (_label, override) => {
    expectDiscoveryParseError({ ...validDiscovery(), ...override });
  });

  it.each([
    ["audiences", { audiences: null }],
    ["custom fields", { custom_fields: "first_name" }],
    ["warnings", { warnings: {} }],
  ])("rejects a wrong-type %s collection", (_label, override) => {
    expectDiscoveryParseError({ ...validDiscovery(), ...override });
  });

  it("rejects oversized arrays before they can enter renderer state", () => {
    expectDiscoveryParseError({
      ...validDiscovery(),
      audiences: new Array(
        MIGRATION_DISCOVERY_WIRE_LIMITS.audiences + 1,
      ).fill(null),
    });
    expectDiscoveryParseError({
      ...validDiscovery(),
      custom_fields: new Array(
        MIGRATION_DISCOVERY_WIRE_LIMITS.customFields + 1,
      ).fill("field"),
    });
    expectDiscoveryParseError({
      ...validDiscovery(),
      warnings: new Array(
        MIGRATION_DISCOVERY_WIRE_LIMITS.warnings + 1,
      ).fill("warning"),
    });
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["wrong type", "12"],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["over limit", MIGRATION_DISCOVERY_WIRE_LIMITS.count + 1],
  ])("rejects a %s discovery count", (_label, count) => {
    expectDiscoveryParseError({
      ...validDiscovery(),
      subscribers_count: count,
    });
    expectDiscoveryParseError({
      ...validDiscovery(),
      templates_count: count,
    });
  });
});

describe("migration dry-run acknowledgement decoder", () => {
  it("accepts only the exact initiating job identity", () => {
    expect(
      parseMigrationDryRunAcknowledgement({ job_id: "job_1" }, "job_1"),
    ).toEqual({ data: { job_id: "job_1" } });
  });

  it.each([
    null,
    undefined,
    [],
    {},
    { job_id: 1 },
    { job_id: " " },
    {
      job_id: "a".repeat(MIGRATION_DISCOVERY_WIRE_LIMITS.jobIdLength + 1),
    },
    { job_id: "job_2" },
    { job_id: "job_1", unexpected: true },
  ])("returns one fixed parse error for an invalid acknowledgement: %j", (value) => {
    const result = parseMigrationDryRunAcknowledgement(value, "job_1");
    if (!result.error) throw new Error("expected dry-run parse failure");

    expect(result.data).toBeUndefined();
    expect(result.error).toEqual({
      kind: "parse",
      code: "migration_preview_invalid_ack",
      message: "The migration dry-run response could not be verified.",
    });
    expect(result.retryability).toBe("manual");
  });
});
