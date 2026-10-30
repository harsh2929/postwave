import { describe, expect, it } from "vitest";

import {
  applyRuntimeMigrationCapability,
  MIGRATION_SOURCES,
} from "../../lib/migration-sources";

function source(id: string) {
  const match = MIGRATION_SOURCES.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`Missing migration source fixture: ${id}`);
  return match;
}

describe("migration authorization contract compatibility", () => {
  it("pins the two non-obvious desktop flows to the registered service adapters", () => {
    expect(source("convertkit")).toMatchObject({
      authFlow: "oauth",
      fields: [],
    });
    expect(source("substack")).toMatchObject({
      authFlow: "csv_upload",
      fields: [expect.objectContaining({ key: "file", kind: "file" })],
    });
  });

  it("cross-checks every source against every server authorization method", () => {
    const methods = ["oauth2", "api_key", "csv_upload"] as const;
    for (const staticSource of MIGRATION_SOURCES) {
      const expected =
        staticSource.authFlow === "oauth"
          ? "oauth2"
          : staticSource.authFlow === "api_key"
            ? "api_key"
            : staticSource.authFlow === "csv_upload"
              ? "csv_upload"
              : null;
      for (const auth_method of methods) {
        const reconciled = applyRuntimeMigrationCapability(staticSource, {
          source: staticSource.id,
          auth_method,
          intake_available: true,
          commit_available: true,
        });
        if (auth_method === expected) {
          expect(reconciled.serverSupport, staticSource.id).toBe(true);
          expect(reconciled.fields, staticSource.id).toEqual(
            staticSource.fields,
          );
          expect(reconciled.runtimeCompatibilityError).toBeUndefined();
        } else {
          expect(
            reconciled.serverSupport,
            `${staticSource.id}/${auth_method}`,
          ).toBe(false);
          expect(reconciled.fields).toEqual([]);
          expect(reconciled.intakeAvailable).toBe(false);
          expect(reconciled.commitAvailable).toBe(false);
        }
      }
    }
  });

  it("fails closed when an OAuth source is advertised as API-key based", () => {
    const reconciled = applyRuntimeMigrationCapability(source("mailchimp"), {
      source: "mailchimp",
      auth_method: "api_key",
    });

    expect(reconciled.serverSupport).toBe(false);
    expect(reconciled.authFlow).toBe("oauth");
    expect(reconciled.fields).toEqual([]);
    expect(reconciled.runtimeCompatibilityError).toContain(
      "requires an API credential",
    );
    expect(reconciled.runtimeCompatibilityError).toContain(
      "supports browser OAuth",
    );
  });

  it("does not invent an OAuth handoff for a credential-only source", () => {
    const reconciled = applyRuntimeMigrationCapability(source("klaviyo"), {
      source: "klaviyo",
      auth_method: "oauth2",
    });

    expect(reconciled.serverSupport).toBe(false);
    expect(reconciled.fields).toEqual([]);
    expect(reconciled.runtimeCompatibilityError).toContain(
      "requires browser OAuth",
    );
  });

  it("retains the reviewed input schema only for the matching runtime flow", () => {
    const staticSource = source("klaviyo");
    const reconciled = applyRuntimeMigrationCapability(staticSource, {
      source: "klaviyo",
      auth_method: "api_key",
      supports: { subscribers: true },
    });

    expect(reconciled.serverSupport).toBe(true);
    expect(reconciled.fields).toEqual(staticSource.fields);
    expect(reconciled.runtimeCompatibilityError).toBeUndefined();
  });

  it("rejects a capability row bound to another source", () => {
    const reconciled = applyRuntimeMigrationCapability(source("klaviyo"), {
      source: "mailchimp",
      auth_method: "api_key",
      intake_available: true,
      commit_available: true,
    });
    expect(reconciled.serverSupport).toBe(false);
    expect(reconciled.fields).toEqual([]);
    expect(reconciled.runtimeCompatibilityError).toContain("does not match");
  });
});
