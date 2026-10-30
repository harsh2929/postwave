/**
 * The wire contract for audience destinations.
 *
 * The assertion that carries the weight is the UNKNOWN STATUS one. An audience
 * destination pushes subscriber lists into live ad platforms; a row the server
 * calls `disconnected` or `error` rendering as healthy is the failure this
 * screen exists to prevent, and defaulting an unrecognised status to "active"
 * is the easy way to cause it.
 */
import { describe, expect, it } from "vitest";

import {
  parseDestination,
  parseDestinations,
  parseSyncJobs,
  syncJobSummary,
  syncJobTone,
} from "./audienceDestinationRows";

describe("audience destination wire parsing", () => {
  it("reads a full row", () => {
    const row = parseDestination({
      id: "d1",
      provider: "meta",
      status: "active",
      list_id: "l1",
      external_audience_id: "ext-9",
      last_synced_at: "2026-08-18T10:00:00Z",
      updated_at: "2026-08-18T11:00:00Z",
    });
    expect(row?.provider).toBe("meta");
    expect(row?.status).toBe("active");
    expect(row?.listId).toBe("l1");
    expect(row?.segmentId).toBeNull();
    expect(row?.lastSyncedAt).toBe("2026-08-18T10:00:00Z");
  });

  it("survives Go's omitempty dropping every optional field", () => {
    const row = parseDestination({ id: "d2", provider: "google", status: "draft" });
    expect(row?.listId).toBeNull();
    expect(row?.segmentId).toBeNull();
    expect(row?.externalAudienceId).toBe("");
    expect(row?.lastSyncedAt).toBeNull();
  });

  it("never renders an unknown status as healthy", () => {
    // A status this client does not know is not a status it may downplay.
    for (const status of ["", "wat", "ACTIVE", "deleted"]) {
      expect(parseDestination({ id: "x", status })?.status).toBe("error");
    }
    // ...and every status the server actually defines round-trips.
    for (const status of [
      "draft",
      "active",
      "paused",
      "syncing",
      "error",
      "disconnected",
    ]) {
      expect(parseDestination({ id: "x", status })?.status).toBe(status);
    }
  });

  it("drops rows with no id rather than rendering a blank card", () => {
    expect(parseDestination({ provider: "meta" })).toBeNull();
    expect(parseDestinations([{ id: "a" }, {}, { id: "b" }])).toHaveLength(2);
  });

  it("accepts both a bare array and an enveloped body", () => {
    expect(parseDestinations([{ id: "a" }])).toHaveLength(1);
    expect(parseDestinations({ destinations: [{ id: "a" }] })).toHaveLength(1);
    expect(parseDestinations(null)).toEqual([]);
    expect(parseDestinations({ destinations: "nope" })).toEqual([]);
  });

  it("parses sync jobs and defaults a missing count to zero", () => {
    const jobs = parseSyncJobs({
      jobs: [
        { id: "j1", status: "failed", error: "429 from provider", members_synced: 0 },
        { id: "j2", status: "succeeded" },
      ],
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.error).toBe("429 from provider");
    expect(jobs[1]?.membersSynced).toBe(0);
  });

  /**
   * THE TEST THAT WAS MISSING. The one above fed `{ jobs: [...] }` — a shape
   * the server has never sent. `ListJobs` writes
   * `map[string]any{"items": jobs}` (handlers.go:560), so the parser's `.jobs`
   * lookup fell through to `[]` on every real response: a permanently empty
   * run history that failed silently. Pinning the SERVER'S key is what makes
   * this parser falsifiable; the shape-agnostic test above never could be.
   */
  it("reads the server's real envelope key, `items`", () => {
    const jobs = parseSyncJobs({
      items: [
        {
          id: "j1",
          status: "failed",
          error: "429 from provider",
          members_synced: 0,
          started_at: "2026-08-18T10:00:00Z",
          finished_at: "2026-08-18T10:00:09Z",
        },
      ],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("failed");
    expect(jobs[0]?.error).toBe("429 from provider");
    expect(jobs[0]?.startedAt).toBe("2026-08-18T10:00:00Z");
    expect(jobs[0]?.finishedAt).toBe("2026-08-18T10:00:09Z");
  });

  it("still accepts a bare array and a non-list body", () => {
    expect(parseSyncJobs([{ id: "j1", status: "succeeded" }])).toHaveLength(1);
    expect(parseSyncJobs({ items: "nope" })).toEqual([]);
    expect(parseSyncJobs(null)).toEqual([]);
  });
});

describe("sync job presentation", () => {
  it("never reads a non-success as healthy", () => {
    expect(syncJobTone("succeeded")).toBe("success");
    expect(syncJobTone("running")).toBe("neutral");
    expect(syncJobTone("failed")).toBe("warning");
    expect(syncJobTone("rejected")).toBe("warning");
    // The provider may or may not have taken the members. "In progress" is
    // exactly the wrong conclusion, so it warns.
    expect(syncJobTone("needs_reconciliation")).toBe("warning");
    // An unknown status is not evidence of success.
    expect(syncJobTone("brand-new-server-status")).toBe("warning");
  });

  it("leads with the provider's own words when a job failed", () => {
    expect(
      syncJobSummary({
        id: "j1",
        status: "failed",
        error: "429 from provider",
        membersSynced: 0,
        startedAt: "2026-08-18T10:00:00Z",
        finishedAt: "2026-08-18T10:00:09Z",
      }),
    ).toBe("429 from provider");
  });

  it("never states a delivered count for a job that is still running", () => {
    expect(
      syncJobSummary({
        id: "j2",
        status: "running",
        error: "",
        membersSynced: 0,
        startedAt: "2026-08-18T10:00:00Z",
        finishedAt: null,
      }),
    ).toBe("Still running.");
  });

  it("states the member count and the finish date on a clean run", () => {
    expect(
      syncJobSummary({
        id: "j3",
        status: "succeeded",
        error: "",
        membersSynced: 1,
        startedAt: "2026-08-18T10:00:00Z",
        finishedAt: "2026-08-18T10:00:09Z",
      }),
    ).toBe("1 member synced · finished 2026-08-18");
  });
});
