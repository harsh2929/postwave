// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { AuditRow } from "@/lib/audit-api";
import {
  activityEntityHref,
  buildActivityItems,
  humanizeAuditRow,
  isPlumbingAction,
} from "@/lib/dashboard-activity";

function row(partial: Partial<AuditRow> & { id: number }): AuditRow {
  return {
    action: "campaign.send",
    resourceType: null,
    resourceId: null,
    actorType: "user",
    actorLabel: null,
    userId: null,
    ip: null,
    userAgent: null,
    metadata: {},
    at: "2026-07-21T12:00:00.000Z",
    ...partial,
  };
}

describe("isPlumbingAction", () => {
  it("flags internal http request-log rows", () => {
    expect(isPlumbingAction("http.post.api.v1.onboarding.sample-data")).toBe(
      true,
    );
    expect(isPlumbingAction("http.patch.api.v1.custom-fields.mode")).toBe(true);
    expect(isPlumbingAction("HTTP")).toBe(true);
  });

  it("does not flag genuine workspace actions", () => {
    expect(isPlumbingAction("campaign.send")).toBe(false);
    expect(isPlumbingAction("subscriber.create")).toBe(false);
    expect(isPlumbingAction(null)).toBe(false);
  });
});

describe("humanizeAuditRow", () => {
  it("maps a known verb + resource + actor to a sentence", () => {
    expect(
      humanizeAuditRow(
        row({ id: 1, action: "campaign.send", resourceType: "campaign", actorLabel: "Ada" }),
      ),
    ).toBe("Sent a campaign · Ada");
  });

  it("omits the actor when absent and picks the right article", () => {
    expect(
      humanizeAuditRow(row({ id: 2, action: "subscriber.create", resourceType: "subscriber" })),
    ).toBe("Created a subscriber");
    expect(
      humanizeAuditRow(row({ id: 3, action: "audience.import", resourceType: "audience" })),
    ).toBe("Imported an audience");
  });

  it("falls back to a readable phrase for an unknown verb", () => {
    expect(
      humanizeAuditRow(row({ id: 4, action: "segment.decay", resourceType: "segment" })),
    ).toBe("Segment decay");
  });
});

describe("activityEntityHref", () => {
  it("resolves a mapped resource to its web path", () => {
    expect(
      activityEntityHref(row({ id: 5, resourceType: "campaign", resourceId: "cmp_1" })),
    ).toBe("/app/campaigns/cmp_1");
  });

  it("returns null for missing id, unknown type, or unsafe id", () => {
    expect(activityEntityHref(row({ id: 6, resourceType: "campaign", resourceId: null }))).toBeNull();
    expect(activityEntityHref(row({ id: 7, resourceType: "not-a-type", resourceId: "x1" }))).toBeNull();
    expect(
      activityEntityHref(row({ id: 8, resourceType: "campaign", resourceId: "../etc/passwd" })),
    ).toBeNull();
  });
});

describe("buildActivityItems", () => {
  it("drops plumbing rows and collapses consecutive duplicates with a count", () => {
    const items = buildActivityItems([
      row({ id: 10, action: "http.patch.api.v1.custom-fields.mode" }),
      row({ id: 9, action: "http.patch.api.v1.custom-fields.mode" }),
      row({ id: 8, action: "settings.update", resourceType: "settings", at: "2026-07-21T11:00:00.000Z" }),
      row({ id: 7, action: "settings.update", resourceType: "settings", at: "2026-07-21T10:59:00.000Z" }),
      row({ id: 6, action: "settings.update", resourceType: "settings", at: "2026-07-21T10:58:00.000Z" }),
      row({ id: 5, action: "campaign.send", resourceType: "campaign", resourceId: "cmp_1", at: "2026-07-21T10:00:00.000Z" }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "audit-8",
      message: "Updated a settings",
      count: 3,
      at: "2026-07-21T11:00:00.000Z",
    });
    expect(items[1]).toMatchObject({
      id: "audit-5",
      message: "Sent a campaign",
      count: 1,
      href: "/app/campaigns/cmp_1",
    });
  });

  it("returns an empty list when every row is plumbing", () => {
    expect(
      buildActivityItems([
        row({ id: 1, action: "http.get.api.v1.dashboard.stats" }),
      ]),
    ).toEqual([]);
  });
});
