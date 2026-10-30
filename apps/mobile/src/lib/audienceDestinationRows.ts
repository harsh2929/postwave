/**
 * lib/audienceDestinationRows.ts — the audience-destination wire contract.
 *
 * Pure by construction and free of react-native imports, so node-run vitest can
 * exercise it: the transport half lives in api/audienceDestinations.ts. Same
 * seam as connectionLifecycle/connectionFamilies.
 *
 * WHY THIS EXISTS. The branch's scope named three connection families;
 * marketing-integrations and integration-writeback shipped as
 * `CONNECTION_FAMILIES`, and this one did not. Worse, the coverage table
 * recorded it as `{ kind: "inside", hostKey: "integrations" }` — a positive
 * claim that mobile offered it — while the integrations screen contained zero
 * mentions of it. The server has had the full surface throughout
 * (internal/audience_destinations/handlers.go).
 *
 * WHY IT IS NOT A THIRD `CONNECTION_FAMILIES` ENTRY. That table models a verb
 * set over an ALREADY-CONNECTED row (run/pause/resume/disconnect). Destinations
 * do not fit: `CreateInput` takes a provider, a list or segment, an external
 * audience id and an opaque `config` JSON blob, so creating one is authoring,
 * not a verb.
 *
 * WHAT MOBILE SHIPS, and why the split falls exactly here:
 *
 *   READ      list, providers, one destination, its sync jobs. A destination
 *             that silently stopped syncing is precisely what somebody checks
 *             from a phone.
 *   PAUSE     PATCH {status: "paused"} — stop a destination that is syncing
 *             wrong data to a live ad audience.
 *   RESUME    PATCH {status: "active"} — the exact inverse, and safe because it
 *             restores a state the operator already configured.
 *   DISCONNECT DELETE — the panic button.
 *
 * NOT CREATE, and not `config` editing. Authoring an opaque provider JSON blob
 * on a phone keyboard is how a destination ends up pointed at the wrong ad
 * audience, and `lib/stoppingHalfPolicy.ts` already settles this shape: the
 * phone gets the stopping half. Resume is included because it is not the
 * STARTING half — it does not create authority or commit new configuration, it
 * un-pauses something a human already set up at a desk.
 */

/** Mirrors audience_destinations.Status (destinations.go:60-68). */
export type DestinationStatus =
  | "draft"
  | "active"
  | "paused"
  | "syncing"
  | "error"
  | "disconnected";

export interface AudienceDestination {
  id: string;
  provider: string;
  status: DestinationStatus;
  listId: string | null;
  segmentId: string | null;
  externalAudienceId: string;
  lastSyncedAt: string | null;
  updatedAt: string | null;
}

/**
 * What `ListJobs` returns at most — `d.Repo.ListSyncJobs(ctx, t.ID, id, 25)`
 * (handlers.go:555). There is no cursor, so a full page is the end of what
 * mobile can ever show and the sheet says so rather than stopping dead.
 */
export const DESTINATION_JOB_LIST_CAP = 25;

export interface DestinationSyncJob {
  id: string;
  status: string;
  error: string;
  membersSynced: number;
  startedAt: string | null;
  finishedAt: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Go's `omitempty` drops list_id, segment_id and last_synced_at, and an unknown
 * status must not be coerced to "active" — a row the server calls broken would
 * then render as healthy, which is the one lie this screen exists to avoid.
 */
export function parseDestination(raw: unknown): AudienceDestination | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!id) return null;
  const status = str(row.status);
  const known: readonly DestinationStatus[] = [
    "draft",
    "active",
    "paused",
    "syncing",
    "error",
    "disconnected",
  ];
  return {
    id,
    provider: str(row.provider),
    status: (known as readonly string[]).includes(status)
      ? (status as DestinationStatus)
      : "error",
    listId: nullableStr(row.list_id),
    segmentId: nullableStr(row.segment_id),
    externalAudienceId: str(row.external_audience_id),
    lastSyncedAt: nullableStr(row.last_synced_at),
    updatedAt: nullableStr(row.updated_at),
  };
}

/**
 * THE ENVELOPE KEY IS `items` HERE TOO. `List` writes
 * `map[string]any{"items": items}` (handlers.go:199) — the same shape as
 * `ListJobs` below — while this parser read only `.destinations`, a key the
 * handler has never sent. Combined with the transport handing over the
 * `{data, error}` wrapper instead of the body, the destinations list was
 * broken twice over and rendered as "no destinations" on every workspace.
 * `destinations` is kept as a tolerated alias for the same reason `jobs` is.
 */
export function parseDestinations(raw: unknown): AudienceDestination[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? ((raw as Record<string, unknown>).items ??
        (raw as Record<string, unknown>).destinations ??
        [])
      : [];
  if (!Array.isArray(list)) return [];
  return list
    .map(parseDestination)
    .filter((row): row is AudienceDestination => row !== null);
}

/**
 * THE ENVELOPE KEY IS `items`, NOT `jobs`. `ListJobs` writes
 * `map[string]any{"items": jobs}` (handlers.go:560) and this parser read
 * `.jobs`, so every response fell through to `[]` — a permanently empty run
 * history that failed SILENTLY, which is the worst possible failure for a
 * screen whose entire job is to say what broke. `jobs` is kept as a tolerated
 * alias rather than swapped, because nothing is gained by rejecting a body a
 * future handler might send, and the test above pins the server's real key.
 */
export function parseSyncJobs(raw: unknown): DestinationSyncJob[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? ((raw as Record<string, unknown>).items ??
        (raw as Record<string, unknown>).jobs ??
        [])
      : [];
  if (!Array.isArray(list)) return [];
  const out: DestinationSyncJob[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    out.push({
      id: str(row.id),
      status: str(row.status),
      error: str(row.error),
      membersSynced:
        typeof row.members_synced === "number" ? row.members_synced : 0,
      startedAt: nullableStr(row.started_at),
      finishedAt: nullableStr(row.finished_at),
    });
  }
  return out;
}

/**
 * Pill tone for ONE sync job.
 *
 * `needs_reconciliation` is deliberately a WARNING and not a neutral: it means
 * the runner could not establish whether the provider took the members, so the
 * external audience may or may not have changed. Reading as "in progress" is
 * exactly the wrong conclusion. Anything unrecognised also warns — an unknown
 * status is not evidence of success.
 */
export function syncJobTone(status: string): "warning" | "success" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "running") return "neutral";
  return "warning";
}

/**
 * The one line under a job that says WHAT HAPPENED.
 *
 * A job still running has no member count worth stating, and a job that failed
 * before sending anything must not read "0 members synced" as though zero were
 * the delivered outcome — the error text is the fact, and it goes first.
 */
export function syncJobSummary(job: DestinationSyncJob): string {
  if (job.error) return job.error;
  if (job.status === "running") return "Still running.";
  const members = `${job.membersSynced} member${job.membersSynced === 1 ? "" : "s"} synced`;
  return job.finishedAt
    ? `${members} · finished ${job.finishedAt.slice(0, 10)}`
    : members;
}

/** Pill tone. A failing or disconnected destination must never read as healthy. */
export function destinationTone(
  status: DestinationStatus,
): "warning" | "success" | "neutral" {
  if (status === "error" || status === "disconnected") return "warning";
  if (status === "paused" || status === "draft") return "neutral";
  return "success";
}

/**
 * The one-line summary under a destination.
 *
 * Says "never synced" rather than leaving the line blank, because a blank line
 * reads as "fine" and a destination that has never synced is the most common
 * misconfiguration this panel exists to surface.
 */
export function destinationSummary(row: AudienceDestination): string {
  const target = row.externalAudienceId
    ? `audience ${row.externalAudienceId}`
    : row.segmentId
      ? "a segment"
      : row.listId
        ? "a list"
        : "no audience selected";
  const synced = row.lastSyncedAt
    ? `last synced ${row.lastSyncedAt.slice(0, 10)}`
    : "never synced";
  return `${target} · ${synced}`;
}
