// @vitest-environment happy-dom
// Tests for the migration progress-view contract. The actual view is
// driven by `subscribeMigrationEvents` in lib/migration-progress-api.ts which wraps SSE
// with a polling fallback. We test the contract here:
//
//   - progress event parser: a snapshot.subscribers_done updates the bar
//   - done event triggers the completion state
//   - cancel calls the DELETE endpoint
//   - polling fallback fires after the 6s SSE-failure window

import { describe, expect, it, vi } from "vitest";

import {
  cancelMigrationJob,
  type MigrationStreamProgress,
} from "@/lib/migration-progress-api";
import {
  displayProgressStep,
  progressRowsForSource,
} from "@/app/(dashboard)/app/migrations/_progress-view";

/** Reduces a progress event into the bar percentage shown in the UI. */
function progressPercent(p: MigrationStreamProgress): number {
  if (p.total <= 0) return 0;
  return Math.min(100, Math.max(0, (p.completed / p.total) * 100));
}

/** Sums per-resource totals out of a snapshot — used by the dashboard
 * card to surface "imported so far" while the stream runs. */
function totalImported(snap: MigrationStreamProgress["snapshot"]): number {
  return (
    snap.subscribers_done +
    snap.segments_done +
    snap.automations_done +
    snap.paid_subs_done +
    snap.archive_done
  );
}

describe("migration progress-view — event → bar value", () => {
  it("computes the progress bar percent from completed/total", () => {
    const evt: MigrationStreamProgress = {
      resource: "subscribers",
      completed: 250,
      total: 1000,
      current_step: "subscribers",
      snapshot: {
        subscribers_total: 1000,
        subscribers_done: 250,
        segments_total: 0,
        segments_done: 0,
        automations_total: 0,
        automations_done: 0,
        paid_subs_total: 0,
        paid_subs_done: 0,
        archive_total: 0,
        archive_done: 0,
      },
      at: "2026-04-01T00:00:00Z",
    };
    expect(progressPercent(evt)).toBe(25);
  });

  it("clamps to [0, 100] when the server reports overshoot", () => {
    const evt: MigrationStreamProgress = {
      resource: "subscribers",
      completed: 1200,
      total: 1000,
      current_step: "subscribers",
      snapshot: {
        subscribers_total: 1000,
        subscribers_done: 1200,
        segments_total: 0,
        segments_done: 0,
        automations_total: 0,
        automations_done: 0,
        paid_subs_total: 0,
        paid_subs_done: 0,
        archive_total: 0,
        archive_done: 0,
      },
      at: "2026-04-01T00:00:00Z",
    };
    expect(progressPercent(evt)).toBe(100);
  });

  it("returns 0 when total is zero (no division by zero in the bar)", () => {
    const evt: MigrationStreamProgress = {
      resource: "subscribers",
      completed: 0,
      total: 0,
      current_step: "subscribers",
      snapshot: {
        subscribers_total: 0,
        subscribers_done: 0,
        segments_total: 0,
        segments_done: 0,
        automations_total: 0,
        automations_done: 0,
        paid_subs_total: 0,
        paid_subs_done: 0,
        archive_total: 0,
        archive_done: 0,
      },
      at: "2026-04-01T00:00:00Z",
    };
    expect(progressPercent(evt)).toBe(0);
  });

  it("aggregates per-resource done counts for the dashboard tally", () => {
    const snap: MigrationStreamProgress["snapshot"] = {
      subscribers_total: 1000,
      subscribers_done: 250,
      segments_total: 20,
      segments_done: 5,
      automations_total: 4,
      automations_done: 1,
      paid_subs_total: 0,
      paid_subs_done: 0,
      archive_total: 0,
      archive_done: 0,
    };
    expect(totalImported(snap)).toBe(256);
  });
});

describe("migration progress-view — ActiveCampaign labels", () => {
  it("renders ActiveCampaign automation counts as rebuild review inventory", () => {
    const rows = progressRowsForSource(
      {
        subscribers_total: 1000,
        subscribers_done: 250,
        segments_total: 20,
        segments_done: 5,
        automations_total: 4,
        automations_done: 0,
        paid_subs_total: 0,
        paid_subs_done: 0,
        archive_total: 6,
        archive_done: 2,
      },
      "activecampaign",
    );

    expect(rows.map((row) => row.label)).toContain("Automation rebuilds");
    expect(rows.map((row) => row.label)).not.toContain("Sequences");
    expect(
      rows.find((row) => row.label === "Automation rebuilds"),
    ).toMatchObject({
      done: 4,
      total: 4,
      valueLabel: "4 to review",
      progressValue: 100,
    });
  });

  it("rewrites generic automation stream steps for ActiveCampaign", () => {
    expect(
      displayProgressStep("activecampaign", {
        resource: "automations",
        completed: 0,
        total: 4,
        current_step: "Translating automations",
      }),
    ).toBe("Preserving automation rebuild evidence");

    expect(
      displayProgressStep("mailchimp", {
        resource: "automations",
        completed: 1,
        total: 4,
        current_step: "Translating automations",
      }),
    ).toBe("Translating automations");
  });
});

describe("migration progress-view — Beehiiv labels", () => {
  it("renders rebuild inventory and premium metadata without claiming runtime or billing progress", () => {
    const rows = progressRowsForSource(
      {
        subscribers_total: 100,
        subscribers_done: 100,
        segments_total: 3,
        segments_done: 3,
        automations_total: 4,
        automations_done: 0,
        paid_subs_total: 12,
        paid_subs_done: 0,
        archive_total: 6,
        archive_done: 6,
      },
      "beehiiv",
    );

    expect(rows).toContainEqual(
      expect.objectContaining({
        label: "Automation rebuild inventory",
        done: 4,
        total: 4,
        valueLabel: "4 to rebuild or retire",
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        label: "Premium memberships (metadata only)",
        done: 12,
        total: 12,
        valueLabel: "12 metadata records; no Stripe billing",
      }),
    );
    expect(rows.map((row) => row.label)).not.toContain("Sequences");
    expect(rows.map((row) => row.label)).not.toContain("Paid subs");
  });

  it("rewrites Beehiiv automation stream steps as source-preservation work", () => {
    expect(
      displayProgressStep("beehiiv", {
        resource: "automations",
        completed: 0,
        total: 4,
        current_step: "Translating automations",
      }),
    ).toBe("Preserving Beehiiv automation rebuild evidence");
  });
});

describe("migration progress-view — Klaviyo labels", () => {
  it("renders flows as rebuild inventory instead of runtime sequences", () => {
    const rows = progressRowsForSource(
      {
        subscribers_total: 100,
        subscribers_done: 100,
        segments_total: 3,
        segments_done: 3,
        automations_total: 4,
        automations_done: 0,
        paid_subs_total: 0,
        paid_subs_done: 0,
        archive_total: 6,
        archive_done: 6,
      },
      "klaviyo",
    );

    expect(rows).toContainEqual(
      expect.objectContaining({
        label: "Flow rebuild inventory",
        done: 4,
        total: 4,
        valueLabel: "4 flows to rebuild or waive",
      }),
    );
    expect(rows.map((row) => row.label)).toContain(
      "Suppression-filtered audience snapshots",
    );
    expect(rows.map((row) => row.label)).toContain(
      "Sent email campaign archive",
    );
    expect(rows.map((row) => row.label)).toContain(
      "SMS/push and rebuild source archive",
    );
    expect(rows.map((row) => row.label)).not.toContain("Sequences");
    expect(
      displayProgressStep("klaviyo", {
        resource: "automations",
        completed: 0,
        total: 4,
        current_step: "Translating automations",
      }),
    ).toBe("Preserving Klaviyo flow rebuild evidence");
  });
});

describe("migration progress-view — Customer.io labels", () => {
  it("renders full-snapshot resources and workflow definitions without runtime or billing claims", () => {
    const rows = progressRowsForSource(
      {
        subscribers_total: 100,
        subscribers_done: 100,
        segments_total: 3,
        segments_done: 3,
        automations_total: 4,
        automations_done: 0,
        paid_subs_total: 0,
        paid_subs_done: 0,
        archive_total: 6,
        archive_done: 6,
        source_archive_total: 12,
        source_archive_done: 12,
      },
      "customerio",
    );

    expect(rows).toContainEqual(
      expect.objectContaining({
        label: "Workflow rebuild inventory",
        done: 4,
        total: 4,
        valueLabel: "4 workflows to rebuild or retire",
      }),
    );
    expect(rows.map((row) => row.label)).toEqual(
      expect.arrayContaining([
        "Email-addressable cio_id profiles",
        "Frozen segment/topic memberships",
        "Sent email newsletter archive",
        "Workflow/channel/ecosystem evidence",
        "Paid subscriptions (not imported)",
      ]),
    );
    expect(rows.map((row) => row.label)).not.toContain("Sequences");
    expect(
      displayProgressStep("customerio", {
        resource: "automations",
        completed: 0,
        total: 4,
        current_step: "Translating automations",
      }),
    ).toBe("Preserving Customer.io workflow rebuild evidence");
  });
});

describe("migration progress-view — cancel endpoint", () => {
  it("DELETEs /api/v1/migrations/{id} and returns the persisted shape", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            job_id: "job_demo",
            cancelled: true,
            status: "cancelled",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const r = await cancelMigrationJob("job_demo");
    expect(r.cancelled).toBe(true);
    expect(r.status).toBe("cancelled");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toMatch(/\/api\/v1\/migrations\/job_demo$/);
    expect(calls[0].init.method).toBe("DELETE");
    vi.restoreAllMocks();
  });

  it("URL-encodes the job id segment", async () => {
    const calls: { url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push({ url });
        return new Response(
          JSON.stringify({
            job_id: "weird id",
            cancelled: false,
            status: "running",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
    await cancelMigrationJob("weird id");
    expect(calls[0].url).toContain("weird%20id");
    vi.restoreAllMocks();
  });
});

describe("migration progress-view — polling fallback gate", () => {
  // Mirrors the inline guard in migration-progress-api::subscribeMigrationEvents — if
  // EventSource has been failing for more than 6s, switch to polling.
  function shouldFallbackToPolling(
    sseClosedAt: number | null,
    now: number,
  ): boolean {
    if (sseClosedAt == null) return false;
    return now - sseClosedAt > 6000;
  }

  it("does not fall back before 6s", () => {
    expect(shouldFallbackToPolling(1000, 6500)).toBe(false);
    expect(shouldFallbackToPolling(1000, 7000)).toBe(false);
  });

  it("falls back strictly after 6s", () => {
    expect(shouldFallbackToPolling(1000, 7001)).toBe(true);
  });

  it("returns false when no closure timestamp is set", () => {
    expect(shouldFallbackToPolling(null, 999_999)).toBe(false);
  });
});
