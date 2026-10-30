// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/campaign-send-checks-api.ts — the two campaign-scoped pre-send surfaces
 * desktop reaches from its SendChecklist and web reached from nowhere.
 *
 * 1. BROKEN-LINK SCAN (parity row campaigns-32).
 *    `POST /api/v1/campaigns/{id}/check-links` HEAD-requests every absolute
 *    href in the SAVED campaign body and answers a bare JSON ARRAY of
 *    verdicts — not an envelope. An empty array is therefore ambiguous on its
 *    own: it means "the saved body contains no absolute links", NOT "every
 *    link is fine". The row copy says which one it is rather than rendering a
 *    green tick over a body nobody scanned.
 *
 *    It reads the body from the `campaigns` row, so it scans what was LAST
 *    SAVED. A link typed into the editor and not yet saved is invisible to it.
 *
 * 2. PRE-SEND AUDIENCE REFINE (parity row campaigns-34, server SUB-067).
 *    `POST` is preview-AND-COMMIT on one path: `dry_run: true` computes the
 *    exclusion set without writing, `dry_run: false` persists it. That single
 *    flag is the whole difference between "show me who would be held back" and
 *    "hold them back", so it is never defaulted here — every caller states it.
 *
 *    `GET` returns the set that is currently committed; `DELETE` clears it and
 *    everyone re-enters the send. The server's own defaults (churn threshold
 *    80, cooling-off 24h) are echoed back in the response, so the panel renders
 *    the server's numbers instead of re-asserting its own.
 *
 * Every call here is online-only and non-replayable: a dry run must never be
 * queued as an offline write, and a commit must never be replayed later
 * against a campaign whose audience has moved on.
 */
import { api } from "@/lib/api";

/** One row of the broken-link sweep (apps/api/internal/link_checker). */
export interface LinkCheckResult {
  url: string;
  /** 0 when the request never produced a status (DNS, TLS, timeout). */
  status: number;
  ok: boolean;
  error?: string;
}

/** One churn-risk-suppressed subscriber in the preview sample. */
export interface PreSendExcludedSubscriber {
  subscriber_id: string;
  email: string;
  churn_score: number;
  reason: string;
}

/** POST/GET /api/v1/campaigns/{id}/presend-refine response. */
export interface PreSendRefineResult {
  campaign_id: string;
  churn_threshold: number;
  cooling_off_hours: number;
  excluded_count: number;
  cooling_off_count: number;
  /** Absent when the exclusions never expire. */
  cooling_off_until?: string;
  dry_run: boolean;
  exclude_recently_paused: boolean;
  affected_subscribers_sample: PreSendExcludedSubscriber[];
}

export interface PreSendRefineInput {
  churn_threshold: number;
  exclude_recently_paused: boolean;
  /** No default: preview and commit are the same path, and this is the switch. */
  dry_run: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseLinkResult(raw: unknown): LinkCheckResult {
  const row = (raw ?? {}) as Record<string, unknown>;
  const error = str(row.error);
  return {
    url: str(row.url),
    status: num(row.status),
    // `ok` is the server's verdict. Absent (or non-boolean) reads as NOT ok:
    // a link we cannot say is reachable is not a link we call reachable.
    ok: row.ok === true,
    ...(error ? { error } : {}),
  };
}

function parseRefineResult(raw: unknown): PreSendRefineResult {
  const row = (raw ?? {}) as Record<string, unknown>;
  const coolingUntil = str(row.cooling_off_until);
  return {
    campaign_id: str(row.campaign_id),
    churn_threshold: num(row.churn_threshold),
    cooling_off_hours: num(row.cooling_off_hours),
    excluded_count: num(row.excluded_count),
    cooling_off_count: num(row.cooling_off_count),
    ...(coolingUntil ? { cooling_off_until: coolingUntil } : {}),
    dry_run: row.dry_run === true,
    exclude_recently_paused: row.exclude_recently_paused === true,
    affected_subscribers_sample: (Array.isArray(
      row.affected_subscribers_sample,
    )
      ? row.affected_subscribers_sample
      : []
    ).map((entry) => {
      const sample = (entry ?? {}) as Record<string, unknown>;
      return {
        subscriber_id: str(sample.subscriber_id),
        email: str(sample.email),
        churn_score: num(sample.churn_score),
        reason: str(sample.reason),
      };
    }),
  };
}

/**
 * Scan the saved campaign body for broken links.
 *
 * The response is a bare array; anything else (an error envelope that slipped
 * through, a null) reads as an empty sweep rather than throwing, and the row
 * distinguishes "no links found" from "all links fine".
 */
export async function checkCampaignLinks(
  campaignId: string,
  options: { signal?: AbortSignal } = {},
): Promise<LinkCheckResult[]> {
  const raw = await api.post<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/check-links`,
    {},
    {
      // A HEAD sweep computes nothing durable. Never mint a mutation identity
      // for it and never let it sit in the offline queue.
      idempotencyKey: null,
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
    },
  );
  return Array.isArray(raw) ? raw.map(parseLinkResult) : [];
}

/** The exclusion set currently committed for this campaign. */
export async function getPresendRefinement(
  campaignId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PreSendRefineResult> {
  const raw = await api.get<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/presend-refine`,
    { signal: options.signal },
  );
  return parseRefineResult(raw);
}

/**
 * Preview (`dry_run: true`) or commit (`dry_run: false`) a refinement.
 *
 * One path, one body, one flag — the caller must say which it means.
 */
export async function refineCampaignAudience(
  campaignId: string,
  input: PreSendRefineInput,
  options: { signal?: AbortSignal } = {},
): Promise<PreSendRefineResult> {
  const raw = await api.post<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/presend-refine`,
    {
      churn_threshold: input.churn_threshold,
      exclude_recently_paused: input.exclude_recently_paused,
      dry_run: input.dry_run,
    },
    {
      idempotencyKey: null,
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
    },
  );
  return parseRefineResult(raw);
}

/** Clear every saved exclusion for this campaign; returns how many went. */
export async function clearCampaignRefinement(
  campaignId: string,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  const raw = await api.delete<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/presend-refine`,
    { requireOnline: true, maxAttempts: 1, signal: options.signal },
  );
  return num((raw as Record<string, unknown> | null)?.cleared);
}
