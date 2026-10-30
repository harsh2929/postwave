import { describe, expect, it } from "vitest";

import { isMigrationAuthFailureMessage } from "../../components/migration/failure-classification";

describe("migration failure classification", () => {
  it("recognizes token-based ActiveCampaign authentication failures", () => {
    expect(isMigrationAuthFailureMessage("activecampaign status 403: bad token")).toBe(true);
    expect(isMigrationAuthFailureMessage("Api-Token rejected by provider")).toBe(true);
    expect(isMigrationAuthFailureMessage("token expired while reconnecting source")).toBe(true);
    expect(isMigrationAuthFailureMessage("ActiveCampaign account API URL required")).toBe(true);
    expect(isMigrationAuthFailureMessage("activecampaign: missing account API URL: auth failed")).toBe(true);
  });

  it("still recognizes legacy API-key and OAuth auth failures", () => {
    expect(isMigrationAuthFailureMessage("auth failed")).toBe(true);
    expect(isMigrationAuthFailureMessage("API key was revoked")).toBe(true);
    expect(isMigrationAuthFailureMessage("401 Unauthorized")).toBe(true);
  });

  it("does not route ordinary migration failures to credential recovery", () => {
    expect(isMigrationAuthFailureMessage("50 subscribers failed validation")).toBe(false);
    expect(isMigrationAuthFailureMessage("source returned status 500")).toBe(false);
  });
});
