// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  buildAssureCampaignPrompt,
  buildMailchimpMigrationPrompt,
} from "../src/prompts/index.js";

describe("Mailchimp migration prompt", () => {
  it("uses the authoritative dry-run scope and asynchronous status contracts", () => {
    const messages = buildMailchimpMigrationPrompt();
    const text = messages.map((message) => message.content.text).join("\n");

    expect(text).toContain("pass its callback job ID as job_id");
    expect(text).toContain("use it as session_id");
    expect(text).toContain(
      "informative rather than the persisted approval boundary",
    );
    expect(text).toContain("until status is awaiting_confirmation or failed");
    expect(text).toContain("authoritative normalized scope");
    expect(text).toContain("poll migrate_rollback_status");
  });
});

describe("Campaign Assurance prompt", () => {
  it("requires approval, honest provenance, a new revision for fixes, and no automatic override", () => {
    const messages = buildAssureCampaignPrompt({
      campaign_id: "cmp_1",
      content_revision_id: "revision_1",
      send_plan_id: "plan_1",
    });
    const text = messages.map((message) => message.content.text).join("\n");

    expect(text).toContain("potentially billable");
    expect(text).toContain("wait for my approval");
    expect(text).toContain("not an event history or SSE stream");
    expect(text).toContain("Predicted Agent Comprehension");
    expect(text).toContain(
      "wait for my explicit approval before campaign_assurance_apply_fix",
    );
    expect(text).toContain("never invent or submit patch instructions");
    expect(text).toContain("treat the originating run as stale");
    expect(text).toContain("run assurance again");
    expect(text).toContain("Never override automatically");
    expect(text).toContain("server-side exact-hash gate remains authoritative");
  });
});
