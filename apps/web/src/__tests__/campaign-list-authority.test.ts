// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const campaignDir = resolve(process.cwd(), "src/app/(dashboard)/app/campaigns");
const read = (file: string) => readFileSync(resolve(campaignDir, file), "utf8");

describe("campaign-list write-authority containment", () => {
  it("fails every list mutation closed behind fresh session authority", () => {
    const source = read("campaigns-client.tsx");

    expect(source).toContain("whoamiFresh");
    expect(source).toContain(
      "assertFreshCampaignWriteAuthority(opened, fresh)",
    );
    expect(source).toMatch(
      /mutationFn: async \(input\) => \{\s*await requireCampaignWriteAuthority\(\);\s*return createCampaign\(input\)/,
    );
    expect(source).toMatch(
      /mutationFn: async \(input\) => \{\s*await requireCampaignWriteAuthority\(\);\s*return createCampaignABTest\(input\)/,
    );
    // The single-row delete is deferred behind an Undo window, so authority is
    // re-checked when it actually commits — not only when the confirmation was
    // opened. The exception is the unload flush, which has no time for a round
    // trip and is authorised by the server like any other request.
    expect(source).toMatch(
      /const commit = async \(trigger: "window" \| "unload"\) => \{[\s\S]*?if \(trigger === "window"\) await requireCampaignWriteAuthority\(\);\s*await deleteCampaign\(campaign\.id, \{\s*beforeUnload: trigger === "unload",?\s*\}\)/,
    );
    // And that window cannot swallow the delete: a page going away flushes it.
    expect(source).toMatch(
      /window\.addEventListener\("pagehide", flushPendingDeletes\)/,
    );
    expect(source).toMatch(
      /document\.addEventListener\("visibilitychange", onHidden\)/,
    );
    expect(source).toMatch(
      /const handleBulkDelete[\s\S]*?await requireCampaignWriteAuthority\(\);[\s\S]*?const results = await Promise\.allSettled\([\s\S]*?deleteCampaign\(id\)/,
    );
    expect(source).toMatch(
      /await requireCampaignWriteAuthority\(\);\s*const clone = await cloneCampaign/,
    );
    expect(source).toMatch(
      /await requireCampaignWriteAuthority\(\);\s*const updated =/,
    );
    expect(source).toMatch(
      /validateCampaignContentLinks[\s\S]*?await requireCampaignWriteAuthority\(\);\s*const res = await sendCampaign/,
    );
  });

  it("passes the read-only state through every list action surface", () => {
    const client = read("campaigns-client.tsx");
    for (const file of [
      "campaign-create-dialog.tsx",
      "campaign-bulk-bar.tsx",
      "campaigns-table.tsx",
      "selected-campaign-actions.tsx",
    ]) {
      const source = read(file);
      expect(source, file).toContain("canWrite");
      expect(source, file).toContain("readOnlyMessage");
    }
    expect(client).toContain("canWrite={canWrite}");
    expect(client).toContain("readOnlyMessage={CAMPAIGN_READ_ONLY_MESSAGE}");
  });
});
