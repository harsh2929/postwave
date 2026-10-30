// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { Campaign } from "@/lib/campaigns-api";
import {
  campaignStatusLabel,
  filterAndSortCampaigns,
  localTimezoneLabel,
  nextCampaignSort,
  pluralize,
  resolvedSendTime,
} from "../app/(dashboard)/app/campaigns/campaign-list-helpers";

function camp(patch: Partial<Campaign>): Campaign {
  return {
    id: patch.id ?? "c1",
    tenant_id: "t",
    name: patch.name ?? "Campaign",
    subject: patch.subject ?? "Subject",
    status: patch.status ?? "draft",
    campaign_type: patch.campaign_type,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: patch.updated_at ?? "2026-01-01T00:00:00Z",
    ...patch,
  };
}

describe("campaignStatusLabel", () => {
  it("title-cases the raw enum", () => {
    expect(campaignStatusLabel("draft")).toBe("Draft");
    expect(campaignStatusLabel("sent")).toBe("Sent");
    expect(campaignStatusLabel("scheduled")).toBe("Scheduled");
  });
});

describe("pluralize", () => {
  it("uses the singular for exactly one", () => {
    expect(pluralize(1, "campaign")).toBe("1 campaign");
  });
  it("uses the plural otherwise and formats the count", () => {
    expect(pluralize(0, "campaign")).toBe("0 campaigns");
    expect(pluralize(1200, "campaign")).toBe("1,200 campaigns");
  });
  it("accepts an explicit plural", () => {
    expect(pluralize(2, "entry", "entries")).toBe("2 entries");
  });
});

describe("nextCampaignSort", () => {
  it("toggles order on the active column", () => {
    expect(nextCampaignSort({ sort: "updated_at", order: "desc" }, "updated_at")).toEqual({
      sort: "updated_at",
      order: "asc",
    });
  });
  it("switches column and starts descending", () => {
    expect(nextCampaignSort({ sort: "updated_at", order: "asc" }, "name")).toEqual({
      sort: "name",
      order: "desc",
    });
  });
});

describe("filterAndSortCampaigns", () => {
  const rows = [
    camp({ id: "a", name: "Beta", status: "draft", updated_at: "2026-01-02T00:00:00Z" }),
    camp({ id: "b", name: "Alpha", status: "sent", campaign_type: "ab_test", updated_at: "2026-01-03T00:00:00Z" }),
    camp({ id: "c", name: "Gamma", status: "draft", updated_at: "2026-01-01T00:00:00Z" }),
  ];

  it("filters by status", () => {
    const out = filterAndSortCampaigns(rows, {
      status: "draft",
      type: "all",
      sort: "updated_at",
      order: "desc",
    });
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("filters by type (defaulting missing type to regular)", () => {
    const out = filterAndSortCampaigns(rows, {
      status: "all",
      type: "ab_test",
      sort: "updated_at",
      order: "desc",
    });
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });

  it("filters by name or subject even when the list endpoint ignores query", () => {
    const withSubjects = [
      ...rows,
      camp({ id: "d", name: "Launch note", subject: "August pricing" }),
    ];
    expect(
      filterAndSortCampaigns(withSubjects, {
        query: "launch",
        status: "all",
        type: "all",
        sort: "updated_at",
        order: "desc",
      }).map((campaign) => campaign.id),
    ).toEqual(["d"]);
    expect(
      filterAndSortCampaigns(withSubjects, {
        query: "PRICING",
        status: "all",
        type: "all",
        sort: "updated_at",
        order: "desc",
      }).map((campaign) => campaign.id),
    ).toEqual(["d"]);
  });

  it("sorts by name ascending", () => {
    const out = filterAndSortCampaigns(rows, {
      status: "all",
      type: "all",
      sort: "name",
      order: "asc",
    });
    expect(out.map((c) => c.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("sorts by updated_at descending (newest first)", () => {
    const out = filterAndSortCampaigns(rows, {
      status: "all",
      type: "all",
      sort: "updated_at",
      order: "desc",
    });
    expect(out.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    filterAndSortCampaigns(input, {
      status: "all",
      type: "all",
      sort: "name",
      order: "asc",
    });
    expect(input.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("resolvedSendTime", () => {
  it("returns '' for empty or invalid input", () => {
    expect(resolvedSendTime("")).toBe("");
    expect(resolvedSendTime("not-a-date")).toBe("");
  });
  it("renders a human absolute string for a valid datetime-local", () => {
    expect(resolvedSendTime("2026-05-01T09:30")).not.toBe("");
  });
});

describe("localTimezoneLabel", () => {
  it("returns a non-empty label", () => {
    expect(localTimezoneLabel().length).toBeGreaterThan(0);
  });
});
