import { describe, expect, it } from "vitest";

import { migrationOAuthDelegationURL } from "../../lib/migration-oauth-handoff";

describe("desktop migration OAuth delegation", () => {
  it("opens the exact hosted source task without a tenant-list claim hint", () => {
    const target = new URL(
      migrationOAuthDelegationURL(
        "https://dashboard.example.test/base/",
        "mailchimp",
      ),
    );

    expect(target.origin).toBe("https://dashboard.example.test");
    expect(target.pathname).toBe("/app/migrations/new/mailchimp");
    expect(target.searchParams.get("desktop_mode")).toBe("delegated");
    expect(target.searchParams.has("desktop_return")).toBe(false);
    expect(target.searchParams.has("job_id")).toBe(false);
  });

  it("does not expose candidate-selection or tenant-list inference APIs", async () => {
    const module = await import("../../lib/migration-oauth-handoff");

    expect(Object.keys(module).sort()).toEqual(["migrationOAuthDelegationURL"]);
  });
});
