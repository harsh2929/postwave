import { describe, expect, it } from "vitest";

import {
  projectDashboardStatsForVault,
  readDashboardStatsSnapshot,
} from "./dashboardOfflineProjection";

const full = {
  range: "30d",
  subscribers_total: 1200,
  subscribers_added_30d: 90,
  subscribers_unsubbed_30d: 10,
  unique_opens_30d: 300,
  unique_delivered_30d: 1000,
  unique_sent_30d: 1010,
  unique_clicks_30d: 40,
  unique_bounces_30d: 10,
  campaigns_sent_30d: 4,
  active_sequences_count: 2,
  previous: { subscribers_added: 60, unique_opens: 250, unique_sent: 900 },
  inbox_health: { score: 88, state: "Good" },
  recent_audit: [
    { id: "1", action: "segment.deleted", actor: "Ava Chen", at: "2026-07-01" },
  ],
};

describe("projectDashboardStatsForVault", () => {
  it("never writes teammate identities to the device", () => {
    // The dashboard deliberately does NOT fire the /audit query, precisely so
    // teammate names stay off disk. A snapshot that re-imported them through
    // the back door would undo that decision silently.
    const projected = projectDashboardStatsForVault(full);
    expect(projected).not.toBeNull();
    expect(projected?.recent_audit).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("Ava");
  });

  it("keeps the counts the six tiles are computed from", () => {
    const projected = projectDashboardStatsForVault(full);
    expect(projected?.subscribers_total).toBe(1200);
    expect(projected?.unique_opens_30d).toBe(300);
    expect(projected?.unique_delivered_30d).toBe(1000);
    expect(projected?.campaigns_sent_30d).toBe(4);
    expect(projected?.active_sequences_count).toBe(2);
    expect(projected?.previous).toEqual({
      subscribers_added: 60,
      unique_opens: 250,
      unique_sent: 900,
    });
    expect(projected?.range).toBe("30d");
  });

  it("keeps the inbox-health SCORE but drops its present-tense claim", () => {
    // "Healthy" is an assertion about NOW; a number from six hours ago is
    // still a number from six hours ago.
    const projected = projectDashboardStatsForVault(full);
    expect(projected?.inbox_health).toEqual({ score: 88 });
  });

  it("is an allowlist, so a new server field cannot leak onto disk", () => {
    const projected = projectDashboardStatsForVault({
      ...full,
      // Two plausible future additions, one of them plainly identifying.
      top_subscriber_email: "ceo@acme.test",
      experimental_llm_summary: "Ava sent the wrong list on Tuesday",
    } as never);
    expect(JSON.stringify(projected)).not.toContain("acme.test");
    expect(JSON.stringify(projected)).not.toContain("Tuesday");
  });

  it("refuses impossible counts rather than caching them", () => {
    const projected = projectDashboardStatsForVault({
      subscribers_total: -5,
      campaigns_sent_30d: Number.NaN,
      active_sequences_count: 3,
    });
    expect(projected).toEqual({ active_sequences_count: 3 });
  });

  it("returns null when nothing usable survived", () => {
    // The caller must treat this as "no snapshot" — writing an empty husk
    // would read back later as a successful load of a zero workspace.
    expect(projectDashboardStatsForVault(undefined)).toBeNull();
    expect(projectDashboardStatsForVault({})).toBeNull();
    expect(
      projectDashboardStatsForVault({ recent_audit: [{ actor: "Ava" }] }),
    ).toBeNull();
  });

  it("preserves a genuine measured zero", () => {
    const projected = projectDashboardStatsForVault({
      subscribers_total: 0,
      campaigns_sent_30d: 0,
    });
    expect(projected).toEqual({ subscribers_total: 0, campaigns_sent_30d: 0 });
  });
});

describe("readDashboardStatsSnapshot", () => {
  it("re-projects on read, so a rule tightened today applies to yesterday's blob", () => {
    const stale = { subscribers_total: 12, recent_audit: [{ actor: "Ava" }] };
    expect(readDashboardStatsSnapshot(stale)).toEqual({
      subscribers_total: 12,
    });
  });

  it("refuses a blob that is not an object", () => {
    expect(readDashboardStatsSnapshot(null)).toBeNull();
    expect(readDashboardStatsSnapshot("{}")).toBeNull();
    expect(readDashboardStatsSnapshot([{ subscribers_total: 1 }])).toBeNull();
  });
});
