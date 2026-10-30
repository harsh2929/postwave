/**
 * The wire shapes and presentation decisions for subscriber import jobs.
 *
 * The three properties these tests exist to pin, because each one has a
 * plausible-looking implementation that would silently lie on a real screen:
 *
 *   1. A MISSING COUNTER IS NOT ZERO. `Deps.List` COALESCEs every counter, so a
 *      response that omits one has drifted — and rendering that as "0 rows
 *      imported" beside "Finished" tells an operator their import did nothing.
 *   2. AN UNRECOGNISED STATUS NEVER READS AS FINISHED. A newer server adding a
 *      seventh status must degrade to "unknown", not to "done".
 *   3. THE POLL STOPS. `importPollIntervalMs` returns false for every terminal
 *      status, for `preview`, and whenever the screen is unfocused or offline —
 *      Expo Router keeps visited tabs mounted, so anything else polls forever
 *      on a screen nobody is looking at.
 */
import { describe, expect, it } from "vitest";

import {
  count,
  filterImportJobs,
  importFilterCounts,
  importFilterFor,
  importOutcomeCounts,
  importPollIntervalMs,
  importProgressCounts,
  importProgressFraction,
  importStatusPresentation,
  isActiveImport,
  isTerminalImport,
  onExistingDescription,
  parseImportJob,
  parseImportJobDetail,
  parseImportJobPage,
  timestamp,
  IMPORT_QUEUED_POLL_MS,
  IMPORT_RUNNING_POLL_MS,
  SUBSCRIBER_IMPORT_STATUSES,
  type SubscriberImportJob,
} from "./subscriberImportJobs";

/** The literal row map `Deps.List` writes (subscriber_import.go:1374). */
function wireRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    filename: "members.csv",
    status: "running",
    rows_total: 50_000,
    rows_new: 42_000,
    rows_existing: 7_500,
    rows_file_dupes: 500,
    rows_imported: 12_000,
    rows_skipped: 300,
    rows_failed: 4,
    on_existing: "skip",
    error_code: "",
    error: "",
    created_at: "2026-07-25T09:00:00Z",
    processed_rows: 12_304,
    cancel_requested: false,
    last_chunk_at: "2026-07-25T09:04:00Z",
    ...overrides,
  };
}

function job(overrides: Partial<SubscriberImportJob> = {}): SubscriberImportJob {
  return { ...parseImportJob(wireRow())!, ...overrides };
}

describe("count", () => {
  it("returns null — never 0 — for a counter the payload did not carry", () => {
    expect(count(undefined)).toBeNull();
    expect(count(null)).toBeNull();
    expect(count("")).toBeNull();
    expect(count(true)).toBeNull();
    expect(count(Number.NaN)).toBeNull();
  });

  it("keeps a real zero as a real zero", () => {
    expect(count(0)).toBe(0);
    expect(count("0")).toBe(0);
  });

  it("tolerates a string-encoded int64, which a future encoder may emit", () => {
    expect(count("250000")).toBe(250_000);
  });
});

describe("timestamp", () => {
  it("reads rfc3339OrEmpty's empty string as absent", () => {
    expect(timestamp("")).toBeNull();
    expect(timestamp(null)).toBeNull();
  });

  it("refuses the zero time so a never-run job cannot render as year 1", () => {
    expect(timestamp("0001-01-01T00:00:00Z")).toBeNull();
  });

  it("keeps a real timestamp verbatim", () => {
    expect(timestamp("2026-07-25T09:00:00Z")).toBe("2026-07-25T09:00:00Z");
  });
});

describe("parseImportJob", () => {
  it("maps every field the List handler writes", () => {
    const parsed = parseImportJob(wireRow())!;
    expect(parsed.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.filename).toBe("members.csv");
    expect(parsed.status).toBe("running");
    expect(parsed.rowsTotal).toBe(50_000);
    expect(parsed.processedRows).toBe(12_304);
    expect(parsed.onExisting).toBe("skip");
    expect(parsed.cancelRequested).toBe(false);
    expect(parsed.lastChunkAt).toBe("2026-07-25T09:04:00Z");
  });

  it("rejects a row with no id rather than rendering an unopenable card", () => {
    expect(parseImportJob({ ...wireRow(), id: "" })).toBeNull();
    expect(parseImportJob(null)).toBeNull();
    expect(parseImportJob([])).toBeNull();
  });

  it("names a blank filename rather than leaving an untitled row", () => {
    expect(parseImportJob({ ...wireRow(), filename: "  " })!.filename).toBe(
      "Untitled upload",
    );
  });

  it("nulls a counter the payload omitted instead of substituting zero", () => {
    const parsed = parseImportJob({ ...wireRow(), rows_imported: undefined })!;
    expect(parsed.rowsImported).toBeNull();
    // The counters that WERE sent are unaffected.
    expect(parsed.rowsTotal).toBe(50_000);
  });

  it("treats cancel_requested strictly, so a truthy string is not a cancel", () => {
    expect(
      parseImportJob({ ...wireRow(), cancel_requested: "false" })!
        .cancelRequested,
    ).toBe(false);
    expect(
      parseImportJob({ ...wireRow(), cancel_requested: true })!.cancelRequested,
    ).toBe(true);
  });
});

describe("parseImportJobDetail", () => {
  it("carries the preflight state the Confirm gate is decided on", () => {
    const detail = parseImportJobDetail({
      ...wireRow({ status: "preview" }),
      preflight_required: false,
      classification_authoritative: true,
      preflight_expires_at: "2026-07-25T10:00:00Z",
      source_fingerprint: "sfp_abc",
      consent_contract_state: "complete",
      schedule_type: "immediate",
      next_scheduled_at: "",
      dry_run: false,
    })!;
    expect(detail.preflightRequired).toBe(false);
    expect(detail.classificationAuthoritative).toBe(true);
    expect(detail.preflightExpiresAt).toBe("2026-07-25T10:00:00Z");
    expect(detail.sourceFingerprint).toBe("sfp_abc");
    expect(detail.consentContractState).toBe("complete");
    expect(detail.nextScheduledAt).toBeNull();
  });

  it("fails closed: an absent preflight verdict is not an authoritative one", () => {
    const detail = parseImportJobDetail(wireRow({ status: "preview" }))!;
    expect(detail.classificationAuthoritative).toBe(false);
    expect(detail.consentContractState).toBe("none");
  });
});

describe("parseImportJobPage", () => {
  it("reads the {imports, has_more, next_cursor} envelope", () => {
    const page = parseImportJobPage({
      imports: [wireRow(), wireRow({ id: "22222222-2222-4222-8222-222222222222" })],
      has_more: true,
      next_cursor: "cur_1",
    });
    expect(page.jobs).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("cur_1");
  });

  it("tolerates a bare array, the drift that silently empties mobile lists", () => {
    expect(parseImportJobPage([wireRow()]).jobs).toHaveLength(1);
  });

  it("returns an empty page — not a throw — for an unrecognisable payload", () => {
    expect(parseImportJobPage(null).jobs).toEqual([]);
    expect(parseImportJobPage({ items: [wireRow()] }).jobs).toEqual([]);
    expect(parseImportJobPage({}).hasMore).toBe(false);
  });

  it("drops an unusable row without dropping its neighbours", () => {
    const page = parseImportJobPage({ imports: [{ id: "" }, wireRow()] });
    expect(page.jobs).toHaveLength(1);
  });
});

describe("importStatusPresentation", () => {
  it("covers every status the worker actually writes", () => {
    for (const status of SUBSCRIBER_IMPORT_STATUSES) {
      const shown = importStatusPresentation(status);
      expect(shown.label).not.toBe("");
      expect(shown.description).not.toBe("");
    }
  });

  it("calls a preview STAGED, not in-progress — nothing has been written", () => {
    const shown = importStatusPresentation("preview");
    expect(shown.label).toBe("Staged");
    expect(shown.description).toMatch(/Nothing has been written/);
  });

  it("says Stopping once cancellation was requested on a live job", () => {
    expect(importStatusPresentation("running", true).label).toBe("Stopping");
    expect(importStatusPresentation("queued", true).label).toBe("Stopping");
    expect(importStatusPresentation("running", false).label).toBe("Running");
  });

  it("never renders an unknown status as finished", () => {
    const shown = importStatusPresentation("quiesced");
    expect(shown.label).toBe("quiesced");
    expect(shown.tone).not.toBe("success");
    expect(shown.description).toMatch(/doesn't know/);
  });
});

describe("status predicates", () => {
  it("matches the server's terminalStatus exactly", () => {
    expect(isTerminalImport("ready")).toBe(true);
    expect(isTerminalImport("failed")).toBe(true);
    expect(isTerminalImport("cancelled")).toBe(true);
    expect(isTerminalImport("running")).toBe(false);
    expect(isTerminalImport("queued")).toBe(false);
    expect(isTerminalImport("preview")).toBe(false);
  });

  it("counts queued and running — and only those — as active", () => {
    expect(isActiveImport("queued")).toBe(true);
    expect(isActiveImport("running")).toBe(true);
    expect(isActiveImport("preview")).toBe(false);
    expect(isActiveImport("ready")).toBe(false);
  });
});

describe("bucketing", () => {
  it("files every status into exactly one bucket", () => {
    expect(importFilterFor("queued")).toBe("active");
    expect(importFilterFor("running")).toBe("active");
    expect(importFilterFor("preview")).toBe("staged");
    expect(importFilterFor("ready")).toBe("done");
    expect(importFilterFor("failed")).toBe("done");
    expect(importFilterFor("cancelled")).toBe("done");
  });

  it("never loses a job whose status this build does not know", () => {
    expect(importFilterFor("quiesced")).toBe("done");
  });

  it("counts sum to the whole set, so no tab hides a job", () => {
    const jobs = [
      job({ status: "queued" }),
      job({ status: "running" }),
      job({ status: "preview" }),
      job({ status: "ready" }),
      job({ status: "failed" }),
      job({ status: "quiesced" }),
    ];
    const counts = importFilterCounts(jobs);
    expect(counts).toEqual({ active: 2, staged: 1, done: 3 });
    expect(counts.active + counts.staged + counts.done).toBe(jobs.length);
    expect(filterImportJobs(jobs, "active")).toHaveLength(2);
  });
});

describe("importProgressFraction", () => {
  it("is null — no determinate bar — when either counter is unknown", () => {
    expect(
      importProgressFraction({
        processedRows: null,
        rowsTotal: 100,
        status: "running",
      }),
    ).toBeNull();
    expect(
      importProgressFraction({
        processedRows: 10,
        rowsTotal: null,
        status: "running",
      }),
    ).toBeNull();
  });

  it("is null for a zero-row total rather than dividing by zero", () => {
    expect(
      importProgressFraction({
        processedRows: 0,
        rowsTotal: 0,
        status: "running",
      }),
    ).toBeNull();
  });

  it("draws NO bar for a staged row, which the worker has not touched", () => {
    // A 0%-wide bar beside "Staged" claims the worker started and got nowhere.
    expect(
      importProgressFraction({
        processedRows: 0,
        rowsTotal: 50_000,
        status: "preview",
      }),
    ).toBeNull();
  });

  it("DOES draw an empty bar for a queued row, which is about to move", () => {
    expect(
      importProgressFraction({
        processedRows: 0,
        rowsTotal: 50_000,
        status: "queued",
      }),
    ).toBe(0);
  });

  it("clamps a counter that overshot its total", () => {
    expect(
      importProgressFraction({
        processedRows: 120,
        rowsTotal: 100,
        status: "running",
      }),
    ).toBe(1);
    expect(
      importProgressFraction({
        processedRows: 25,
        rowsTotal: 100,
        status: "running",
      }),
    ).toBe(0.25);
  });
});

describe("importProgressCounts", () => {
  it("is null when a counter is missing, so the row shows an em-dash", () => {
    expect(
      importProgressCounts({ processedRows: null, rowsTotal: 10 }),
    ).toBeNull();
  });

  it("reports a genuine zero-of-many, which is a real state at kick-off", () => {
    expect(importProgressCounts({ processedRows: 0, rowsTotal: 5000 })).toEqual({
      processed: 0,
      total: 5000,
    });
  });
});

describe("importOutcomeCounts", () => {
  it("withholds the outcome while the job is still in flight", () => {
    expect(importOutcomeCounts(job({ status: "running" }))).toBeNull();
    expect(importOutcomeCounts(job({ status: "queued" }))).toBeNull();
    expect(importOutcomeCounts(job({ status: "preview" }))).toBeNull();
  });

  it("reports the outcome once the worker is done with the row", () => {
    expect(importOutcomeCounts(job({ status: "ready" }))).toEqual({
      imported: 12_000,
      skipped: 300,
      failed: 4,
    });
  });

  it("passes an unknown counter through as null rather than as zero", () => {
    expect(
      importOutcomeCounts(job({ status: "failed", rowsImported: null })),
    ).toEqual({ imported: null, skipped: 300, failed: 4 });
  });
});

describe("importPollIntervalMs", () => {
  const on = { focused: true, online: true };

  it("polls a running job fastest and a queued job slower", () => {
    expect(importPollIntervalMs("running", on)).toBe(IMPORT_RUNNING_POLL_MS);
    expect(importPollIntervalMs("queued", on)).toBe(IMPORT_QUEUED_POLL_MS);
  });

  it("stops dead on every terminal status", () => {
    expect(importPollIntervalMs("ready", on)).toBe(false);
    expect(importPollIntervalMs("failed", on)).toBe(false);
    expect(importPollIntervalMs("cancelled", on)).toBe(false);
  });

  it("does not poll a preview: nothing moves until a human confirms it", () => {
    expect(importPollIntervalMs("preview", on)).toBe(false);
  });

  it("does not poll an unfocused tab — Expo Router keeps it mounted", () => {
    expect(importPollIntervalMs("running", { focused: false, online: true })).toBe(
      false,
    );
  });

  it("does not poll offline", () => {
    expect(importPollIntervalMs("running", { focused: true, online: false })).toBe(
      false,
    );
  });

  it("does not poll a status it has not yet received", () => {
    expect(importPollIntervalMs(null, on)).toBe(false);
    expect(importPollIntervalMs(undefined, on)).toBe(false);
  });
});

describe("onExistingDescription", () => {
  it("spells out the three strategies the confirm handler validates", () => {
    expect(onExistingDescription("skip")).toMatch(/left untouched/);
    expect(onExistingDescription("update")).toMatch(/updated/);
    expect(onExistingDescription("error")).toMatch(/fails the import/);
  });

  it("says nothing rather than guessing at an unknown strategy", () => {
    expect(onExistingDescription("merge")).toBeNull();
    expect(onExistingDescription("")).toBeNull();
  });
});
