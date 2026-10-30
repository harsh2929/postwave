/**
 * lib/audienceSyncs.ts — the wire shapes of the reverse-ETL audience-sync
 * subsystem, and how one RUN reads. Import-free, so every decision below is
 * unit-testable in the node vitest environment (house rule 6).
 *
 * Every fact here was read off the Go source, never off openapi.json:
 * `apps/api/internal/audience_destinations/syncs.go` declares `Sync`, `SyncRun`
 * and the schedule/status constant blocks; `sync_handlers.go` decides the
 * envelopes; `sync_runner.go` and `operation_safety.go` decide what a status
 * MEANS. Six of those facts shape this module and every one is easy to get
 * wrong:
 *
 *  1. THE LIST CARRIES THE OUTCOME. Unlike agent routines, `syncSelectColumns`
 *     (syncs.go:308) selects `last_run_status` alongside `last_run_at`, and
 *     `finishSyncOperationTx` (operation_safety.go:340) denormalises the run's
 *     terminal status onto the sync row in the same transaction. So a list row
 *     can honestly say "last night's sync FAILED" without opening anything —
 *     which is the entire reason this surface is worth a phone.
 *  2. THERE ARE SIX RUN STATUSES, NOT THREE. `running`, `succeeded`, `failed`,
 *     `rejected`, `partial`, `needs_reconciliation` (syncs.go:87-94). Three of
 *     them are failure shades a two-state UI would flatten into a lie:
 *     `partial` means rows WERE delivered before it broke; `rejected` means
 *     the audience blew the cap and NOTHING was sent; `needs_reconciliation`
 *     means external effects may have landed with no acknowledgement.
 *  3. `last_run_at` IS STAMPED AT RUN *END*, not at start. Both writers
 *     (operation_safety.go:211 and :340) set it beside a TERMINAL status. That
 *     is what makes the overdue arithmetic in lib/audienceSyncHealth exact.
 *  4. A RUN LEFT AT `running` IS NOT NECESSARILY IN PROGRESS. Run-now executes
 *     INLINE under `SyncRunTimeout` (sync_runner.go:54 — sixty seconds), and
 *     only `finishSyncOperationTx` writes a terminal status. If the process
 *     dies mid-run the row stays `running` forever; nothing sweeps it, and the
 *     lease-expiry rewrite to `needs_reconciliation` only fires when a LATER
 *     operation reuses the same key. Past the lease bound the honest label is
 *     "outcome unknown", never a spinner that will never stop.
 *  5. `/{id}/runs` IS CAPPED AT 25 WITH NO CURSOR. `ListSyncRuns` is called
 *     with a literal 25 from `sync_handlers.go:209`. There is no pagination to
 *     offer, so the screen says so rather than implying more is reachable.
 *  6. THE DESTINATION SECRET IS NEVER ON THE WIRE. Reads substitute
 *     `secret_set` + a masked `secret_hint` (`scanSync`, syncs.go:337-338), and
 *     `maskDestinationConfig` replaces every credential-bearing config key with
 *     a fixed "••••" sentinel. Nothing here reconstructs or displays a secret.
 */

/** `ScheduleManual` / `ScheduleHourly` / `ScheduleDaily` (syncs.go:80-84). */
export const SYNC_SCHEDULES = ["manual", "hourly", "daily"] as const;
export type SyncSchedule = (typeof SYNC_SCHEDULES)[number];

/** The `audience_sync_runs.status` CHECK set (syncs.go:87-94). */
export const SYNC_RUN_STATUSES = [
  "running",
  "succeeded",
  "partial",
  "failed",
  "rejected",
  "needs_reconciliation",
] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

/** `allowedDestinationTypes` — mirrors the migration 1114 CHECK (syncs.go:49). */
export const SYNC_DESTINATION_TYPES = [
  "webhook",
  "meta",
  "google_ads",
  "tiktok",
  "linkedin",
  "snap",
] as const;

/** `SyncMaxRows` (sync_runner.go:46). A run over this is `rejected`. */
export const SYNC_MAX_ROWS = 50_000;

/** `SyncRunTimeout` (sync_runner.go:54). Run-now is inline, so this bounds it. */
export const SYNC_RUN_TIMEOUT_MS = 60_000;

/** `operationLeaseDuration = 2 * SyncRunTimeout` (operation_safety.go:25). */
export const SYNC_RUN_LEASE_MS = 2 * SYNC_RUN_TIMEOUT_MS;

/**
 * Past this, a `running` row did not finish normally (fact 4). The lease bound
 * plus a minute of slack for the terminal write to land.
 */
export const SYNC_RUN_STALL_MS = SYNC_RUN_LEASE_MS + 60_000;

/** `sync_handlers.go:209` passes a literal 25; the repo clamps to it anyway. */
export const SYNC_RUN_LIST_CAP = 25;

export interface AudienceSyncDestination {
  /** webhook | meta | google_ads | tiktok | linkedin | snap. */
  type: string;
  /**
   * The receiver URL for a webhook destination. Platform destinations persist
   * the destination TYPE here as a placeholder (`CreateSync`, syncs.go:497-500),
   * so it is only shown when the type is actually `webhook`.
   */
  url: string;
  /** Read-side substitute for the write-only HMAC secret. */
  secretSet: boolean;
  secretHint: string;
  /** Masked platform config: ids pass through, credentials become "••••". */
  config: Record<string, unknown> | null;
}

export interface AudienceSync {
  id: string;
  name: string;
  /** Exactly one of these is set — the 0376 XOR CHECK guarantees it. */
  listId: string | null;
  segmentId: string | null;
  destination: AudienceSyncDestination;
  schedule: SyncSchedule | string;
  /** The scheduler's due-scan filters on `WHERE enabled` (sync_scheduler.go:117). */
  enabled: boolean;
  /** Stamped at run END. Null = never completed a run. */
  lastRunAt: string | null;
  /** Denormalised terminal status of that run. Empty = never run. */
  lastRunStatus: string;
  /** Overrides the destination-derived consent purpose for the firewall. */
  requiredConsentPurpose: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AudienceSyncRun {
  id: string;
  syncId: string;
  status: SyncRunStatus | string;
  /** Rows actually delivered. Null when the field was absent — never 0. */
  rowsExported: number | null;
  batchesSent: number | null;
  /** How many members the source resolved to before the firewall. */
  sourceMembersObserved: number | null;
  /** How many the activation firewall withheld (migration 0407). */
  excludedCount: number | null;
  /** True when the source blew `SyncMaxRows` and the run was rejected. */
  capExceeded: boolean;
  startedAt: string | null;
  /** Null while running AND on any run that never reached a terminal write. */
  finishedAt: string | null;
  /** Operator-visible failure text, truncated to 2000 chars server-side. */
  error: string;
  externalJobID: string;
  externalAudienceID: string;
  providerMessage: string;
  providerStatus: string;
  providerCheckedAt: string | null;
  /** "manual" | "scheduled" — COALESCEd to 'manual' by the repo. */
  triggerKind: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A count, or null when the field was absent or not a number. ABSENCE IS NOT
 * ZERO: "0 rows exported" is a measurement and a serious claim about a sync;
 * a missing field is the absence of one, and the screen renders an em-dash.
 */
export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * An ISO timestamp, or null. Go's zero `time.Time` serialises as
 * `0001-01-01T00:00:00Z`, which is present-but-meaningless — rendering it puts
 * "1 January year 1" on screen instead of an em-dash.
 */
export function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

function parseDestination(value: unknown): AudienceSyncDestination {
  const row = record(value);
  const config = record(row["config"]);
  return {
    type: str(row["type"]) || "webhook",
    url: str(row["url"]),
    // Non-pointer bool server-side. An ABSENT value must not read as "a secret
    // is configured" — that would claim a signature the receiver may not get.
    secretSet: row["secret_set"] === true,
    secretHint: str(row["secret_hint"]),
    config: Object.keys(config).length > 0 ? config : null,
  };
}

export function parseSync(value: unknown): AudienceSync | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  const source = record(row["source"]);
  return {
    id,
    name: str(row["name"]),
    listId: str(source["list_id"]) || null,
    segmentId: str(source["segment_id"]) || null,
    destination: parseDestination(row["destination"]),
    schedule: str(row["schedule"]) || "manual",
    // An absent `enabled` must not read as "the scheduler is running this".
    enabled: row["enabled"] === true,
    lastRunAt: timestamp(row["last_run_at"]),
    lastRunStatus: str(row["last_run_status"]),
    requiredConsentPurpose: str(row["required_consent_purpose"]),
    createdAt: timestamp(row["created_at"]),
    updatedAt: timestamp(row["updated_at"]),
  };
}

function itemsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const items = record(payload)["items"];
  return Array.isArray(items) ? items : [];
}

/**
 * `GET /api/v1/audience-syncs` answers `{"items":[…]}` (sync_handlers.go:78).
 * A bare array is accepted too, for one line, because envelope drift silently
 * emptying a mobile screen is the most common failure class in this codebase.
 */
export function parseSyncList(payload: unknown): AudienceSync[] {
  return itemsOf(payload)
    .map(parseSync)
    .filter((row): row is AudienceSync => row !== null);
}

export function parseSyncRun(value: unknown): AudienceSyncRun | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  return {
    id,
    syncId: str(row["sync_id"]),
    // A run row with no status is not a success. Left verbatim (and empty) so
    // `runStatusPresentation` falls through to its unknown branch.
    status: str(row["status"]),
    rowsExported: count(row["rows_exported"]),
    batchesSent: count(row["batches_sent"]),
    sourceMembersObserved: count(row["source_members_observed"]),
    excludedCount: count(row["excluded_count"]),
    capExceeded: row["cap_exceeded"] === true,
    startedAt: timestamp(row["started_at"]),
    finishedAt: timestamp(row["finished_at"]),
    error: str(row["error"]),
    externalJobID: str(row["external_job_id"]),
    externalAudienceID: str(row["external_audience_id"]),
    providerMessage: str(row["provider_message"]),
    providerStatus: str(row["provider_status"]),
    providerCheckedAt: timestamp(row["provider_checked_at"]),
    triggerKind: str(row["trigger_kind"]),
  };
}

/** `GET /{id}/runs` answers `{"items":[…]}`, newest-first (syncs.go:709). */
export function parseSyncRunList(payload: unknown): AudienceSyncRun[] {
  return itemsOf(payload)
    .map(parseSyncRun)
    .filter((row): row is AudienceSyncRun => row !== null);
}

/**
 * `POST /{id}/run` answers 200 with the CLOSED run row itself — not an ack and
 * not a 202. A failed run is still HTTP 200 with `status:"failed"` (the handler
 * comment at sync_handlers.go:172-175 says exactly that), so the caller must
 * read the returned status rather than treating a resolved promise as success.
 */
export function parseRunNowResult(payload: unknown): AudienceSyncRun | null {
  return parseSyncRun(payload);
}

export function destinationTypeLabel(type: string): string {
  switch (type.trim().toLowerCase()) {
    case "webhook":
      return "Webhook";
    case "meta":
      return "Meta";
    case "google_ads":
      return "Google Ads";
    case "tiktok":
      return "TikTok";
    case "linkedin":
      return "LinkedIn";
    case "snap":
      return "Snapchat";
    default:
      // Never guess. An unrecognised type is shown verbatim so an operator can
      // report exactly what their workspace returned.
      return type.trim() || "Unknown destination";
  }
}

export function scheduleLabel(schedule: string): string {
  switch (schedule.trim().toLowerCase()) {
    case "hourly":
      return "Hourly";
    case "daily":
      return "Daily";
    case "manual":
      return "Manual only";
    default:
      return schedule.trim() || "Unknown schedule";
  }
}

/** Which side of the XOR the source came from. Never both, never neither. */
export function sourceLabel(sync: Pick<AudienceSync, "listId" | "segmentId">): string {
  if (sync.segmentId) return "Segment";
  if (sync.listId) return "List";
  return "Unknown source";
}

export function triggerLabel(triggerKind: string): string {
  switch (triggerKind.trim().toLowerCase()) {
    case "scheduled":
      return "On schedule";
    case "manual":
      return "By hand";
    default:
      return triggerKind.trim() || "Unknown trigger";
  }
}

export interface RunPresentation {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  /**
   * The full sentence a screen reader hears in place of the compacted pill.
   * State is never colour-alone and never a one-word label alone.
   */
  spoken: string;
}

const TERMINAL_PRESENTATION: Readonly<Record<string, RunPresentation>> = {
  succeeded: {
    label: "Succeeded",
    tone: "success",
    spoken: "This run succeeded: every resolved member was delivered.",
  },
  partial: {
    label: "Partial",
    tone: "warning",
    spoken:
      "This run delivered some batches and then failed. The destination holds part of the audience, so the two sides disagree until it runs again.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    spoken: "This run failed and delivered nothing.",
  },
  rejected: {
    label: "Rejected",
    tone: "danger",
    spoken:
      "This run was rejected before anything was sent, because the source audience is larger than the per-run cap.",
  },
  needs_reconciliation: {
    label: "Needs reconciliation",
    tone: "danger",
    spoken:
      "This run never acknowledged an outcome, and it had already started sending. The destination may hold rows nobody recorded, so it needs checking by hand.",
  },
};

/**
 * How a single run reads. `now` is required rather than defaulted so the stall
 * rule is deterministic under test and cannot silently depend on the wall clock
 * of whoever runs the suite.
 */
export function runStatusPresentation(
  run: Pick<AudienceSyncRun, "status" | "startedAt" | "finishedAt">,
  now: number,
): RunPresentation {
  const status = run.status.trim().toLowerCase();
  const terminal = TERMINAL_PRESENTATION[status];
  if (terminal) return terminal;
  if (status === "running") {
    const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    if (Number.isFinite(started) && now - started > SYNC_RUN_STALL_MS) {
      return {
        label: "Outcome unknown",
        tone: "warning",
        spoken:
          "This run never recorded an outcome. A run is bounded at sixty seconds and its lease at two minutes, so it did not finish normally.",
      };
    }
    return {
      label: "Running",
      tone: "neutral",
      spoken: "This run is still in progress.",
    };
  }
  return {
    label: status ? run.status.trim() : "Unknown",
    tone: "neutral",
    spoken: `This run reported an unrecognised status: ${
      status ? run.status.trim() : "none at all"
    }.`,
  };
}

/** True while any run in the list is worth polling for a terminal status. */
export function hasLiveRun(
  runs: readonly Pick<AudienceSyncRun, "status" | "startedAt" | "finishedAt">[],
  now: number,
): boolean {
  return runs.some((run) => runStatusPresentation(run, now).label === "Running");
}

/**
 * How long a run took, in ms — or null when that is not knowable. A run still
 * in progress is measured against `now`; a run with no parsable start yields
 * null and the caller renders an em-dash. Never zero: "0ms" is a measurement,
 * and this is the absence of one.
 */
export function runDurationMs(
  run: Pick<AudienceSyncRun, "startedAt" | "finishedAt">,
  now: number,
): number | null {
  const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return null;
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  const end = Number.isFinite(finished) ? finished : now;
  const delta = end - started;
  return delta >= 0 ? delta : null;
}

// There is deliberately no `latestRun` helper here, and its absence is the
// point: on THIS surface the sync row already carries `last_run_status`, so
// nothing ever has to reduce the run list to find the verdict. (The agent-
// routines surface needs one precisely because its list does not.)
