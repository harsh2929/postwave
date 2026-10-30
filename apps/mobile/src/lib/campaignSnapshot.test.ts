import { describe, expect, it } from "vitest";

import {
  campaignListSnapshotRow,
  type CampaignSnapshotRow,
} from "./campaignSnapshot";

/** A wire row as the list endpoint actually serialises it. */
function wireRow(): CampaignSnapshotRow & {
  tenant_id: string;
  body_html: string;
  body_mjml: string;
  updated_at: string;
} {
  return {
    id: "c1",
    tenant_id: "t1",
    name: "March promo",
    subject: "50% off",
    status: "sent",
    // The wire row can carry the WHOLE email — this is the field that pushes a
    // 40-row snapshot past the vault's per-entry ceiling, at which point the
    // write is silently dropped and the snapshot is permanently empty.
    body_html: "x".repeat(50_000),
    body_mjml: "y".repeat(50_000),
    scheduled_at: null,
    sent_at: "2026-03-01T10:00:00Z",
    created_at: "2026-02-20T10:00:00Z",
    updated_at: "2026-03-01T10:00:00Z",
    open_rate: 0.42,
    click_rate: 0.08,
    delivery_settings: { ab_test: { is_parent: true } },
  };
}

describe("campaignListSnapshotRow", () => {
  it("drops the bodies that would blow the vault's per-entry ceiling", () => {
    const row = campaignListSnapshotRow(wireRow());
    expect("body_html" in row).toBe(false);
    expect("body_mjml" in row).toBe(false);
    expect(JSON.stringify(row).length).toBeLessThan(400);
  });

  it("keeps every field a list row actually renders", () => {
    const row = campaignListSnapshotRow(wireRow());
    expect(row).toMatchObject({
      id: "c1",
      name: "March promo",
      subject: "50% off",
      status: "sent",
      sent_at: "2026-03-01T10:00:00Z",
      created_at: "2026-02-20T10:00:00Z",
      open_rate: 0.42,
      click_rate: 0.08,
    });
  });

  it("omits absent keys rather than writing explicit undefineds", () => {
    // exactOptionalPropertyTypes is on; an explicit `undefined` in the JSON
    // round-trip is a different value from an absent key on rehydrate.
    const row = campaignListSnapshotRow({ id: "c2" });
    expect(Object.keys(row)).toEqual(["id"]);
  });

  it("keeps the A/B parentage the list pill reads", () => {
    const row = campaignListSnapshotRow(wireRow());
    expect(row.delivery_settings).toEqual({ ab_test: { is_parent: true } });
  });

  it("fits 40 rows inside a 24KB vault entry", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      campaignListSnapshotRow({ ...wireRow(), id: `c${i}` }),
    );
    expect(JSON.stringify(rows).length).toBeLessThan(24_000);
  });
});
