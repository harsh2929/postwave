import { beforeEach, describe, expect, it } from "vitest";

import {
  consumePendingMigrationApiKeyReturn,
  parseMigrationApiKeyReturn,
  setPendingMigrationApiKeyReturn,
} from "../lib/migration-deep-link";

describe("migration deep-link handoff", () => {
  beforeEach(() => {
    consumePendingMigrationApiKeyReturn();
  });

  it("parses supported migration API-key return paths", () => {
    expect(
      parseMigrationApiKeyReturn(
        "/app/migrations/api-key?source=brevo&state=st_123",
      ),
    ).toEqual({ source: "brevo", state: "st_123" });
  });

  it("trims empty state but keeps the source", () => {
    expect(
      parseMigrationApiKeyReturn(
        "/app/migrations/api-key?source=hubspot&state=%20%20",
      ),
    ).toEqual({ source: "hubspot" });
  });

  it("rejects unrelated paths and unknown sources", () => {
    expect(parseMigrationApiKeyReturn("/app/migrations")).toBeNull();
    expect(
      parseMigrationApiKeyReturn(
        "/app/migrations/api-key?source=unknown&state=st_123",
      ),
    ).toBeNull();
  });

  it("consumes the pending return exactly once", () => {
    setPendingMigrationApiKeyReturn({
      source: "activecampaign",
      state: "st_456",
    });

    expect(consumePendingMigrationApiKeyReturn()).toEqual({
      source: "activecampaign",
      state: "st_456",
    });
    expect(consumePendingMigrationApiKeyReturn()).toBeNull();
  });
});
