import { describe, expect, it } from "vitest";

import { auditActionLabel } from "./auditActionLabel";

describe("auditActionLabel", () => {
  it.each([
    ["campaign.sent", "Campaign sent"],
    ["subscriber.delete", "Subscriber deleted"],
    ["api_key.rotate", "API key rotated"],
    ["campaign.schedule_updated", "Campaign schedule updated"],
    ["segment.decay", "Segment decay"],
  ])("humanizes noun/action keys: %s", (key, label) => {
    expect(auditActionLabel(key)).toBe(label);
  });

  it.each([
    ["http.POST.api.v1.subscribers", "Subscribers created"],
    [
      "human http.post.api.v1.notifications.seen",
      "Notifications marked as seen",
    ],
    ["human http.POST.api.v2.campaigns.send", "Campaigns sent"],
    [
      "agent.http.PATCH.api.v1.custom-fields.mode",
      "Custom fields mode updated",
    ],
    ["system.http.DELETE.api.v3.api-keys.revoke", "API keys revoked"],
    ["http.GET.api.v1.dashboard.stats", "Dashboard stats viewed"],
  ])("removes HTTP plumbing and actor prefixes: %s", (key, label) => {
    expect(auditActionLabel(key)).toBe(label);
  });

  it.each([
    ["login", "Signed in"],
    ["auth.login", "Signed in"],
    ["user.login.succeeded", "Sign-in succeeded"],
    ["auth.login.failed", "Sign-in failed"],
    ["user.logout", "Signed out"],
    ["auth.failed", "Authentication failed"],
    ["mfa.enrolled", "MFA enrolled"],
    ["auth.mfa.challenge_failed", "MFA challenge failed"],
  ])("uses familiar authentication language: %s", (key, label) => {
    expect(auditActionLabel(key)).toBe(label);
  });

  it("preserves acronym casing and humanizes unknown separators and camelCase", () => {
    expect(auditActionLabel("oauthToken/API_keyUpdated")).toBe(
      "OAuth token API key updated",
    );
    expect(auditActionLabel("webhookDelivery:retry")).toBe(
      "Webhook delivery retried",
    );
    expect(auditActionLabel("pii.exported_toCSV")).toBe("PII exported to CSV");
    expect(auditActionLabel("Campaign sent")).toBe("Campaign sent");
  });

  it.each([undefined, null, "", "   ", "...___---"])(
    "falls back for a blank or unreadable key: %s",
    (key) => {
      expect(auditActionLabel(key)).toBe("Event");
    },
  );
});
