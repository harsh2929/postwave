// Quick-compose routing contract (App.tsx ↔ Campaigns.tsx).
//
// The global CmdOrCtrl+Shift+P shortcut emits `quick-compose`; App.tsx
// stashes an EMPTY pending campaign draft and routes to the campaigns
// section. Campaigns.tsx opens its New Campaign modal on mount whenever
// `consumePendingCampaignDraft()` returns a truthy value — these tests
// pin the handoff-store semantics that the shortcut path depends on
// (truthy empty draft, consumed exactly once, clearable).

import { describe, expect, it } from "vitest";

import {
  AI_GENERATED_HTML_MARKER,
  consumePendingCampaignDraft,
  markAIGeneratedHTML,
  peekPendingCampaignDraft,
  setPendingCampaignDraft,
} from "../../lib/template-handoff";

describe("quick-compose pending-draft handoff", () => {
  it("an empty draft is truthy so Campaigns auto-opens the composer", () => {
    setPendingCampaignDraft({});
    const draft = consumePendingCampaignDraft();
    expect(draft).toBeTruthy();
    expect(draft).toEqual({});
  });

  it("is consumed exactly once — no modal re-pop on a later remount", () => {
    setPendingCampaignDraft({});
    expect(consumePendingCampaignDraft()).toEqual({});
    expect(consumePendingCampaignDraft()).toBeNull();
    expect(peekPendingCampaignDraft()).toBeNull();
  });

  it("can be cleared without consuming", () => {
    setPendingCampaignDraft({ name: "Stale" });
    setPendingCampaignDraft(null);
    expect(consumePendingCampaignDraft()).toBeNull();
  });

  it("marks direct AI HTML idempotently before campaign handoff", () => {
    const once = markAIGeneratedHTML("<p>Hello</p>");
    expect(once).toContain(`<!-- ${AI_GENERATED_HTML_MARKER} -->`);
    expect(once).toContain("<p>Hello</p>");
    expect(markAIGeneratedHTML(once)).toBe(once);
    expect(markAIGeneratedHTML(undefined)).toBeUndefined();
  });

  it("projects active and linked model markup into inert reviewed text", () => {
    const safe = markAIGeneratedHTML(
      '<script>steal()</script><p>Hello <a href="javascript:steal()">team</a></p><img src="https://tracker.example/pixel">',
    );

    expect(safe).toContain("<p>Hello team</p>");
    expect(safe).not.toContain("<script");
    expect(safe).not.toContain("<a ");
    expect(safe).not.toContain("<img");
    expect(safe).not.toContain("javascript:");
    expect(safe).not.toContain("tracker.example");
    expect(markAIGeneratedHTML(safe)).toBe(safe);
  });
});
