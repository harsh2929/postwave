import { describe, expect, it } from "vitest";

import { parseMigrationSourceCapabilities } from "../../lib/api/migrations";

describe("migration source capability response normalization", () => {
  it("accepts direct and wrapped capability arrays", () => {
    const capability = {
      source: "mailchimp",
      auth_method: "oauth2",
      supports: { subscribers: true },
    };
    expect(parseMigrationSourceCapabilities([capability])).toEqual({
      data: [capability],
    });
    expect(parseMigrationSourceCapabilities({ sources: [capability] })).toEqual(
      { data: [capability] },
    );
    expect(parseMigrationSourceCapabilities({ items: [capability] })).toEqual({
      data: [capability],
    });
  });

  it("keeps a valid empty catalog distinct from malformed envelopes", () => {
    expect(parseMigrationSourceCapabilities([])).toEqual({ data: [] });
    expect(parseMigrationSourceCapabilities({ items: [] })).toEqual({
      data: [],
    });
    expect(parseMigrationSourceCapabilities({ count: 0 })).toMatchObject({
      error: {
        kind: "parse",
        code: "migration_sources_invalid_envelope",
      },
    });
  });

  it("fails the whole response closed for malformed, duplicate, or incompatible rows", () => {
    const capability = {
      source: "mailchimp",
      auth_method: "oauth2",
      supports: { subscribers: true },
    };
    for (const payload of [
      [capability, { source: "beehiiv" }],
      [capability, capability],
      [{ source: "mailchimp", auth_method: "device_code" }],
      [
        {
          source: "mailchimp",
          auth_method: "oauth2",
          supports: { subscribers: "yes" },
        },
      ],
    ]) {
      expect(parseMigrationSourceCapabilities(payload)).toMatchObject({
        error: {
          kind: "parse",
          code: "migration_sources_invalid_item",
        },
      });
    }
  });

  it("strictly decodes deployment intake and commit attestations", () => {
    const available = {
      source: "csv",
      auth_method: "csv_upload",
      intake_available: true,
      commit_available: true,
      supports: { subscribers: true },
    };
    const unavailable = {
      source: "csv",
      auth_method: "csv_upload",
      intake_available: false,
      intake_unavailable_code: "durable_upload_storage_unavailable",
      commit_available: false,
      commit_unavailable_code: "tenant_destination_not_isolated",
    };

    expect(parseMigrationSourceCapabilities([available])).toEqual({
      data: [available],
    });
    expect(parseMigrationSourceCapabilities([unavailable])).toEqual({
      data: [unavailable],
    });

    for (const capability of [
      { ...available, intake_available: "yes" },
      { ...available, commit_available: 1 },
      {
        ...available,
        intake_unavailable_code: "durable_upload_storage_unavailable",
      },
      {
        ...unavailable,
        intake_unavailable_code: undefined,
      },
      {
        ...unavailable,
        commit_unavailable_code: "unknown_destination_policy",
      },
      {
        ...unavailable,
        commit_unavailable_code: undefined,
      },
    ]) {
      expect(parseMigrationSourceCapabilities([capability])).toMatchObject({
        error: {
          kind: "parse",
          code: "migration_sources_invalid_item",
        },
      });
    }
  });
});
