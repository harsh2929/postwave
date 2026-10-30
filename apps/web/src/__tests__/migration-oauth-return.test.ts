import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { migrationOAuthReturnPath } from "@/lib/migration-oauth-return";

describe("migration OAuth callback return path", () => {
  it("returns same-job reconnects from the detail page to that detail page", () => {
    expect(
      migrationOAuthReturnPath("mailchimp", "job/with space", "detail", false),
    ).toBe("/app/migrations/job%2Fwith%20space");
  });

  it("returns review reconnects to the same job in the wizard", () => {
    expect(
      migrationOAuthReturnPath("mailchimp", "job_1", "review", false),
    ).toBe("/app/migrations/new/mailchimp?step=review&job_id=job_1");
  });

  it("keeps the desktop handoff destination authoritative", () => {
    expect(migrationOAuthReturnPath("mailchimp", "job_1", "detail", true)).toBe(
      "/app/migrations?desktop_handoff=complete&job_id=job_1",
    );
  });

  it("offers Mailchimp same-job reconnect from the migration detail route", () => {
    const detailPage = readFileSync(
      new URL(
        "../app/(dashboard)/app/migrations/[jobId]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(detailPage).toContain('job.source === "mailchimp"');
    expect(detailPage).toContain("<OAuthSessionReconnectCard");
    expect(detailPage).toContain('returnTo="detail"');
  });

  it("offers Beehiiv same-job publication reconnect from the migration detail route", () => {
    const detailPage = readFileSync(
      new URL(
        "../app/(dashboard)/app/migrations/[jobId]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(detailPage).toContain('job.source === "beehiiv"');
    expect(detailPage).toContain("<ActiveCampaignSessionReconnectCard");
    expect(detailPage).toContain("source={job.source}");
    expect(detailPage).toContain("onReconnected={(next) =>");
  });
});
