/**
 * lib/audienceDestinationJobSheet.ts — the panel-side decisions behind the
 * destination sync-history sheet: sync-now (P2.41) and the tap-through from a
 * failed job row into its provider diagnostics (P2.42).
 *
 * The sheet (components/integrations/DestinationSyncJobsSheet.tsx) is
 * presentational and the panel owns the queries, so four small decisions sit
 * between the two: what the jobs query's data is AS A LIST, which job is open
 * after a tap, what sentence a failed diagnostics read gets, and whether a
 * sync-now press may proceed at all. They lived inline in the panel, where the
 * only thing that could reach them was a jest render with ONE global query
 * mock — a mock that cannot fail the diagnostics query while the destinations
 * query succeeds, so the refusal-versus-presentation branch was unreachable.
 *
 * Pure and react-native-free so node-run vitest covers every branch. Same seam
 * as lib/audienceDestinationRows.ts and lib/audienceDestinationActions.ts.
 */
import { diagnosticsRefusalMessage } from "@/lib/audienceDestinationActions";
import type { DestinationSyncJob } from "@/lib/audienceDestinationRows";
import { errorPresentation } from "@/lib/errorCopy";

function isJobRow(entry: unknown): entry is DestinationSyncJob {
  if (typeof entry !== "object" || entry === null) return false;
  const row = entry as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.status === "string";
}

/**
 * The jobs query's data as the list the sheet renders.
 *
 * `undefined` (not loaded yet), `null`, and anything that is not an array all
 * become `[]` — never a throw and never a synthetic row. Entries that are not
 * job rows (a hydrated cache from an older shape) are dropped rather than
 * rendered as a card with no status, because a card with no status reads as a
 * sync that happened.
 */
export function jobsFromQueryData(data: unknown): DestinationSyncJob[] {
  if (!Array.isArray(data)) return [];
  return data.filter(isJobRow);
}

/**
 * A press on a job's "Ask the provider why". Opens that job; a press on the
 * job that is already open closes it. Only one job's diagnostics are fetched
 * at a time, so this is the whole of the open-state rule.
 */
export function toggleOpenJobId(
  current: string | null,
  jobId: string,
): string | null {
  return current === jobId ? null : jobId;
}

/**
 * The sentence under an opened job whose diagnostics read failed.
 *
 * A classified refusal (409 `diagnostics_unavailable`, 503
 * `adapter_unavailable`, …) is a fact about the job and is stated as such;
 * anything else gets the ordinary presentation of the failure. Null when there
 * is no error, and null when the presentation has nothing to say — the sheet
 * then falls back to its own "the read failed" line rather than rendering an
 * empty string as if it were an answer.
 */
export function diagnosticsErrorMessage(error: unknown): string | null {
  if (!error) return null;
  const refusal = diagnosticsRefusalMessage(error);
  if (refusal) return refusal;
  const message = errorPresentation(error).message;
  return message ? message : null;
}

/**
 * Why a sync-now press is refused BEFORE the confirm sheet, or null to let it
 * proceed.
 *
 * Delivering an audience is online-only by construction — the mutation is
 * never registered in the offline outbox, because a push released hours later
 * would land at a moment nobody chose — so an offline press is told that
 * plainly instead of being walked through a confirm and then handed a
 * transport error. Mirrors the desktop section's "You're offline — syncs need
 * a live server" and the audience-sync sheet's `runNowBlockedReason`.
 */
export function syncNowRefusal(input: {
  online: boolean;
  provider: string;
}): string | null {
  if (input.online) return null;
  const name = input.provider || "the destination";
  return `You're offline, so ${name} can't be pushed right now — syncs need a live server.`;
}
