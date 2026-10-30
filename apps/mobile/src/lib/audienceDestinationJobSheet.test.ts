/**
 * The panel-side rules behind the destination sync-history sheet (P2.41
 * sync-now, P2.42 per-job diagnostics tap-through).
 *
 * Expectations are written from the SERVER's behaviour and the sheet's
 * contract, not from the code under test: `JobDiagnostics`
 * (audience_destinations/handlers.go:584-643) refuses with classified codes,
 * and the sheet renders `errorMessage` verbatim with its own fallback for null.
 */
import { describe, expect, it } from "vitest";

import {
  diagnosticsErrorMessage,
  jobsFromQueryData,
  syncNowRefusal,
  toggleOpenJobId,
} from "./audienceDestinationJobSheet";
import type { DestinationSyncJob } from "./audienceDestinationRows";

function job(overrides: Partial<DestinationSyncJob> = {}): DestinationSyncJob {
  return {
    id: "j1",
    status: "failed",
    error: "429 from provider",
    membersSynced: 0,
    startedAt: "2026-08-18T10:00:00Z",
    finishedAt: "2026-08-18T10:00:09Z",
    ...overrides,
  };
}

describe("jobsFromQueryData — the job → row mapping", () => {
  it("renders nothing, and throws nothing, before the query has data", () => {
    expect(jobsFromQueryData(undefined)).toEqual([]);
    expect(jobsFromQueryData(null)).toEqual([]);
  });

  it("never treats a non-array as a list", () => {
    // A hydrated cache or a mocked hook can hand back an envelope or a string;
    // neither is a sync that happened.
    expect(jobsFromQueryData({ items: [job()] })).toEqual([]);
    expect(jobsFromQueryData("nope")).toEqual([]);
    expect(jobsFromQueryData(0)).toEqual([]);
  });

  it("passes well-formed rows through in order", () => {
    const rows = [job(), job({ id: "j2", status: "succeeded", error: "" })];
    expect(jobsFromQueryData(rows)).toEqual(rows);
  });

  it("drops entries that are not job rows rather than rendering a blank card", () => {
    const rows = jobsFromQueryData([
      job(),
      null,
      "j3",
      { id: "no-status" },
      { status: "failed" },
      job({ id: "j4" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["j1", "j4"]);
  });
});

describe("toggleOpenJobId — the tap-through open state", () => {
  it("opens the tapped job when nothing is open", () => {
    expect(toggleOpenJobId(null, "j1")).toBe("j1");
  });

  it("switches to a different job on a second tap elsewhere", () => {
    expect(toggleOpenJobId("j1", "j2")).toBe("j2");
  });

  it("closes the open job when it is tapped again", () => {
    expect(toggleOpenJobId("j1", "j1")).toBeNull();
  });
});

describe("diagnosticsErrorMessage — refusal, presentation, or nothing", () => {
  it("is null when the read has not failed", () => {
    expect(diagnosticsErrorMessage(null)).toBeNull();
    expect(diagnosticsErrorMessage(undefined)).toBeNull();
  });

  it("states a classified refusal as the fact it is", () => {
    // handlers.go:603 — no provider request id was persisted for the job.
    expect(
      diagnosticsErrorMessage(
        Object.assign(new Error("conflict"), {
          status: 409,
          code: "diagnostics_unavailable",
        }),
      ),
    ).toMatch(/No provider request id was recorded/u);
    // handlers.go:639 — the provider itself refused the lookup.
    expect(
      diagnosticsErrorMessage(
        Object.assign(new Error("bad gateway"), {
          status: 502,
          code: "provider_diagnostics_failed",
        }),
      ),
    ).toMatch(/provider refused/u);
  });

  it("falls back to the ordinary presentation for an unclassified failure", () => {
    // errorCopy's generic 5xx line — pinned as a literal so a regression to
    // "" (rendered by the sheet as an empty answer) or to the raw "boom" fails.
    expect(
      diagnosticsErrorMessage(Object.assign(new Error("boom"), { status: 500 })),
    ).toBe("The server had a problem with this request. Please try again.");
  });

  it("reads a 403 as a permission rule rather than a network fault", () => {
    expect(
      diagnosticsErrorMessage(Object.assign(new Error("forbidden"), { status: 403 })),
    ).toMatch(/role/u);
  });
});

describe("syncNowRefusal — the pre-confirm gate", () => {
  it("lets an online press proceed", () => {
    expect(syncNowRefusal({ online: true, provider: "meta" })).toBeNull();
  });

  it("refuses an offline press with the reason, naming the destination", () => {
    const refusal = syncNowRefusal({ online: false, provider: "meta" });
    expect(refusal).toMatch(/offline/u);
    expect(refusal).toContain("meta");
    expect(refusal).toMatch(/live server/u);
  });

  it("still reads as a sentence when the provider name is missing", () => {
    expect(syncNowRefusal({ online: false, provider: "" })).toContain(
      "the destination",
    );
  });
});
