/**
 * lib/cutoverWatch.ts — reading a migration's post-cutover watch on a phone.
 *
 * GOVERNANCE#53. After an import completes, the operator's job stops being
 * "did it work" and becomes "is the OLD platform still receiving traffic".
 * That is a loop that runs for days and does not require a desk, which is
 * precisely why it belongs on a phone — and mobile had nothing for it.
 *
 * WHERE THESE ENDPOINTS LIVE, because looking in the obvious place says they
 * do not exist: `grep -rn shadow-monitor apps/api --include=*.go` returns
 * NOTHING. They are mounted by the separate migration service —
 * services/migration/internal/handlers/migration.go:285-289 —
 *
 *     GET    /v1/migrations/{job_id}/shadow-monitor
 *     GET    /v1/migrations/{job_id}/source-events
 *     PATCH  /v1/migrations/{job_id}/source-events/{event_id}/review
 *
 * and reached from a client through the gateway's reverse proxy at
 * apps/api/main.go:3827-3828 (`/api/v1/migrations` → `/v1/migrations`), behind
 * `apikeys.RequireScope(apikeys.ScopeAdmin)` (main.go:3878-3879). That is the
 * SAME gate the migration job list already passes, so a session that can see a
 * job can always read its watch.
 *
 * THREE ANSWERS THAT ARE STATES, NOT FAILURES:
 *   404 — no monitor was ever started for this job. shadow_monitor.go:131 and
 *         source_events.go:161. The normal answer for the vast majority of
 *         jobs; rendering it red would invent a problem.
 *   503 — this deployment's job store is not monitor-capable
 *         (shadow_monitor.go:120, source_events.go:149). A product boundary.
 *   monitor.enabled === false — a monitor exists but was stopped. Its counters
 *         are FROZEN at the last check. Reporting "0 events since cutover" off
 *         a stopped monitor is the single most dangerous thing this screen
 *         could say, so `enabled` travels with every number derived here.
 *
 * ABSENCE IS NOT ZERO throughout: every count is `number | null` and every
 * timestamp is `string | null`. A monitor that has never run reports no event
 * count, which is not the same sentence as "no events happened".
 *
 * Pure and import-free (house rule 6), so all of it is testable in the node
 * vitest run.
 */

/** The four values `shadow_check.go:400-404` and `:226` can produce. */
export type ShadowAction =
  | "ready_for_cutover_review"
  | "run_delta_import_before_cutover"
  | "manual_review_required"
  | "check_failed";

export type CutoverTone = "ok" | "attention" | "danger" | "neutral";

export interface ShadowCheckRow {
  generatedAt: string | null;
  action: string | null;
  needsDeltaImport: boolean;
  /** Count of blocking findings, or null when the field was absent. */
  blockers: number | null;
  /** Resources whose source total no longer matches what was imported. */
  changedResources: readonly string[];
  error: string | null;
}

export interface ShadowWatch {
  enabled: boolean;
  intervalSeconds: number | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastAction: string | null;
  lastError: string | null;
  history: readonly ShadowCheckRow[];
}

export interface SourceEventRow {
  id: string;
  resourceType: string;
  action: string;
  occurredAt: string | null;
  applied: boolean;
  reviewed: boolean;
  reviewDetail: string | null;
  reviewedAt: string | null;
  error: string | null;
}

export interface SourceEventWatch {
  enabled: boolean;
  intervalSeconds: number | null;
  enabledSince: string | null;
  lastEventAt: string | null;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  eventsSeen: number | null;
  eventsApplied: number | null;
  events: readonly SourceEventRow[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function flag(value: unknown): boolean {
  return value === true;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = record(entry);
    return parsed ? [parsed] : [];
  });
}

function parseShadowCheck(raw: Record<string, unknown>): ShadowCheckRow {
  const deltas = rows(raw.deltas);
  return {
    generatedAt: text(raw.generated_at),
    action: text(raw.recommended_action),
    needsDeltaImport: flag(raw.needs_delta_import),
    blockers: Array.isArray(raw.blockers) ? raw.blockers.length : null,
    // A delta whose count moved is the concrete evidence that the source is
    // still live. `label` is the human name the service already computed.
    changedResources: deltas.flatMap((delta) => {
      const moved = count(delta.delta);
      if (moved == null || moved === 0) return [];
      return [text(delta.label) ?? text(delta.resource) ?? "unnamed resource"];
    }),
    error: text(raw.error),
  };
}

/** `null` when the payload is not a shadow-monitor document at all. */
export function parseShadowWatch(payload: unknown): ShadowWatch | null {
  const body = record(payload);
  const monitor = body ? record(body.monitor) : null;
  if (!monitor) return null;
  return {
    enabled: flag(monitor.enabled),
    intervalSeconds: count(monitor.interval_seconds),
    lastCheckedAt: text(monitor.last_checked_at),
    nextCheckAt: text(monitor.next_check_at),
    lastAction: text(monitor.last_recommended_action),
    lastError: text(monitor.last_error),
    history: rows(body?.history).map(parseShadowCheck),
  };
}

/** `null` when the payload is not a source-event monitor document at all. */
export function parseSourceEventWatch(
  payload: unknown,
): SourceEventWatch | null {
  const body = record(payload);
  const monitor = body ? record(body.monitor) : null;
  if (!monitor) return null;
  return {
    enabled: flag(monitor.enabled),
    intervalSeconds: count(monitor.interval_seconds),
    enabledSince: text(monitor.enabled_since),
    lastEventAt: text(monitor.last_event_at),
    lastSyncedAt: text(monitor.last_synced_at),
    nextSyncAt: text(monitor.next_sync_at),
    lastError: text(monitor.last_error),
    eventsSeen: count(monitor.events_seen),
    eventsApplied: count(monitor.events_applied),
    events: rows(body?.events).flatMap((raw) => {
      const id = text(raw.id);
      if (!id) return [];
      return [
        {
          id,
          resourceType: text(raw.resource_type) ?? "unknown",
          action: text(raw.action) ?? "unknown",
          occurredAt: text(raw.occurred_at),
          applied: flag(raw.applied),
          reviewed: text(raw.review_status) === "reviewed",
          reviewDetail: text(raw.review_detail),
          reviewedAt: text(raw.reviewed_at),
          error: text(raw.error),
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const ACTION_COPY: Record<ShadowAction, { label: string; tone: CutoverTone }> =
  {
    ready_for_cutover_review: {
      label: "Source matches the import",
      tone: "ok",
    },
    run_delta_import_before_cutover: {
      label: "Source has moved — a delta import is needed",
      tone: "attention",
    },
    manual_review_required: {
      label: "Blocked — manual review required",
      tone: "danger",
    },
    check_failed: { label: "The last check could not complete", tone: "danger" },
  };

/**
 * Human copy for a `recommended_action`. An action this build has never heard
 * of is echoed with its underscores stripped rather than dropped: a new server
 * verdict must still reach the reader.
 */
export function shadowActionCopy(action: string | null | undefined): {
  label: string;
  tone: CutoverTone;
} {
  const key = String(action ?? "").trim();
  if (!key) return { label: "No check has run yet", tone: "neutral" };
  const known = ACTION_COPY[key as ShadowAction];
  if (known) return known;
  return { label: key.replace(/_/g, " "), tone: "neutral" };
}

/** Events the operator is being asked to resolve by hand. */
export function pendingReviewCount(watch: SourceEventWatch | null): number {
  if (!watch) return 0;
  // The null check guards the WATCH, not its events array.
  return (Array.isArray(watch.events) ? watch.events : []).filter(
    (event) => !event.applied && event.action === "manual_review" &&
      !event.reviewed,
  ).length;
}

/** Events a human has signed off, which mobile may re-open but never grant. */
export function reviewedCount(watch: SourceEventWatch | null): number {
  if (!watch) return 0;
  return (Array.isArray(watch.events) ? watch.events : []).filter((event) => event.reviewed).length;
}

/**
 * The one sentence this screen exists to answer.
 *
 * The ordering is deliberate and is the whole product judgement here: a
 * STOPPED monitor outranks every number it left behind, because a frozen
 * "nothing changed" reads identically to a live one and is the failure mode
 * that actually loses data during a cutover.
 */
export function cutoverHeadline(input: {
  shadow: ShadowWatch | null;
  events: SourceEventWatch | null;
}): { headline: string; detail: string; tone: CutoverTone } {
  const { shadow, events } = input;
  if (!shadow && !events) {
    return {
      headline: "No cutover watch is running",
      detail:
        "Shadow checks and source-event polling are started from the web app during a pilot overlap. Nothing is watching this job's source platform.",
      tone: "neutral",
    };
  }
  const stopped =
    (shadow !== null && !shadow.enabled) || (events !== null && !events.enabled);
  if (stopped) {
    return {
      headline: "The watch is stopped",
      detail:
        "Counters below are frozen at the last completed check. They are not evidence that the source platform has gone quiet — nothing has looked since.",
      tone: "attention",
    };
  }
  if (shadow?.lastError || events?.lastError) {
    return {
      headline: "The watch is failing",
      detail:
        shadow?.lastError ??
        events?.lastError ??
        "The last poll returned an error.",
      tone: "danger",
    };
  }
  const pending = pendingReviewCount(events);
  if (pending > 0) {
    return {
      headline:
        pending === 1
          ? "1 source change needs manual review"
          : `${pending} source changes need manual review`,
      detail:
        "The source platform changed in a way that cannot be replayed automatically. Each one has to be reconciled before cutover is final.",
      tone: "danger",
    };
  }
  const action = shadowActionCopy(shadow?.lastAction);
  if (action.tone === "danger" || action.tone === "attention") {
    return {
      headline: action.label,
      detail:
        "The last shadow check compared the source account with what was imported and did not clear it for cutover.",
      tone: action.tone,
    };
  }
  const seen = events?.eventsSeen ?? null;
  if (seen != null && seen > 0) {
    return {
      headline:
        seen === 1
          ? "1 source event since cutover"
          : `${seen} source events since cutover`,
      detail:
        "The old platform is still receiving traffic, and every event so far replayed cleanly into Moosewave.",
      tone: "attention",
    };
  }
  return {
    headline: "Source is quiet",
    detail:
      "The watch is running and the last check found nothing new on the source platform.",
    tone: "ok",
  };
}

/**
 * Why the "re-open" control is unavailable for a given event, or `null` when
 * it is available.
 *
 * MOBILE RE-OPENS A SIGN-OFF; IT NEVER GRANTS ONE. The `reviewed` direction of
 * `PATCH …/source-events/{id}/review` requires a reconciliation narrative plus
 * one to fifty auditable evidence references, and both are hard-validated
 * server-side (source_events.go:262-296). That is a compliance record, and a
 * phone is the wrong place to author one — but re-opening costs nothing, needs
 * no body, and is the SAFE direction: it puts a gate back, it never removes
 * one. So it is the only write this surface exposes.
 *
 * The refusals below mirror the handler's own 409s so the button is absent
 * rather than present-and-doomed.
 */
export function reopenUnavailableReason(input: {
  jobStatus: string | null | undefined;
  event: Pick<SourceEventRow, "applied" | "action" | "reviewed">;
}): string | null {
  const status = String(input.jobStatus ?? "").toLowerCase();
  // source_events.go:752 — the review route rejects any job that is not
  // `completed`, whatever the record says.
  if (status !== "completed") {
    return "Review re-opens only on a completed import.";
  }
  if (!input.event.reviewed) return "This event has not been signed off.";
  // source_events.go:239 — an applied event, or one whose action is not
  // `manual_review`, is a replay outcome rather than a review item.
  if (input.event.applied || input.event.action !== "manual_review") {
    return "Only unapplied manual-review events carry a sign-off.";
  }
  return null;
}

/**
 * Staleness sentence for a monitor, given the current time.
 *
 * The whole value of this surface is knowing HOW OLD the reassurance is, so
 * absence is stated rather than hidden: a monitor that has never run says so.
 */
export function watchAgeCopy(
  lastCheckedAt: string | null,
  nowMs: number,
): string {
  if (!lastCheckedAt) return "never checked";
  const at = Date.parse(lastCheckedAt);
  if (!Number.isFinite(at)) return "last check time unknown";
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 90) return "checked just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `checked ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `checked ${hours}h ago`;
  return `checked ${Math.round(hours / 24)}d ago`;
}
