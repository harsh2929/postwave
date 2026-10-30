/**
 * api/deliverabilityEvidence.ts — per-recipient, per-domain and per-campaign
 * deliverability evidence lookups.
 *
 *   POST /api/v1/feedback/history                    (admin — email travels in
 *        the BODY by design so it never enters URLs or request logs)
 *   GET  /api/v1/auth-checks                         (admin, proxied — 502/503
 *        when the deliverability service isn't configured)
 *   GET  /api/v1/inbox-reality/campaigns/{id}        (admin, proxied — 404
 *        until a seed test has reported for the campaign)
 *   POST /api/v1/deliverability/eq-score             (editor)
 *
 * All four are PRESS-DRIVEN lookups, never prefetched: two carry an address or
 * draft content in the request, and the proxied pair are expensive DNS/seed
 * reads that only matter when the operator asks.
 */
import { rawRequest, type AIApiError } from "./request";

import { itemsOf, numberOr, str, WireShapeError } from "@/lib/deliverabilityContracts";

export class EvidenceError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "EvidenceError";
    this.status = error.status;
  }
}

/** 502/503 from a proxied route means "not configured here", not "broken". */
export function isServiceUnavailable(err: unknown): boolean {
  return (
    err instanceof EvidenceError && (err.status === 502 || err.status === 503)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ---------------------------------------------------- feedback history --- */

export interface FeedbackBounce {
  id: string;
  bounceType: string;
  esp: string;
  receivedAt: string;
}

export interface FeedbackComplaint {
  id: string;
  complaintType: string;
  esp: string;
  receivedAt: string;
}

export interface FeedbackHistory {
  bounces: FeedbackBounce[];
  complaints: FeedbackComplaint[];
}

/** Why exactly is this address blocked — the raw ESP feedback trail. */
export async function fetchFeedbackHistory(
  email: string,
): Promise<FeedbackHistory> {
  const res = await rawRequest<unknown>("POST", "/api/v1/feedback/history", {
    email,
  });
  if (res.error) {
    throw new EvidenceError(res.error, "Couldn't load the feedback trail.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("feedback history");
  const bounces: FeedbackBounce[] = [];
  for (const row of itemsOf(res.data.bounces ?? [], "feedback bounces")) {
    if (!isRecord(row)) continue;
    bounces.push({
      id: String(row.id ?? ""),
      bounceType: str(row.bounce_type),
      esp: str(row.esp),
      receivedAt: str(row.received_at),
    });
  }
  const complaints: FeedbackComplaint[] = [];
  for (const row of itemsOf(res.data.complaints ?? [], "feedback complaints")) {
    if (!isRecord(row)) continue;
    complaints.push({
      id: String(row.id ?? ""),
      complaintType: str(row.complaint_type),
      esp: str(row.esp),
      receivedAt: str(row.received_at),
    });
  }
  return { bounces, complaints };
}

/* --------------------------------------------------------- auth checks --- */

export type AuthCheckKey = "spf" | "dkim" | "dmarc" | "bimi" | "ptr";

export const AUTH_CHECK_KEYS: readonly AuthCheckKey[] = [
  "spf",
  "dkim",
  "dmarc",
  "bimi",
  "ptr",
];

export interface AuthCheckCell {
  /** ok | warn | fail | "" (unknown) */
  status: string;
  detail: string;
}

export interface AuthCheckRow {
  domain: string;
  checks: Record<AuthCheckKey, AuthCheckCell>;
}

/** GET /api/v1/auth-checks — BARE ARRAY, one row per resolved sending domain. */
export async function fetchAuthChecks(): Promise<AuthCheckRow[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/auth-checks");
  if (res.error) {
    throw new EvidenceError(res.error, "Couldn't load authentication checks.");
  }
  const out: AuthCheckRow[] = [];
  for (const row of itemsOf(res.data, "auth checks")) {
    if (!isRecord(row)) continue;
    const domain = str(row.domain).trim();
    if (!domain) continue;
    const checks = {} as Record<AuthCheckKey, AuthCheckCell>;
    for (const key of AUTH_CHECK_KEYS) {
      const cell = isRecord(row[key]) ? (row[key] as Record<string, unknown>) : {};
      checks[key] = { status: str(cell.status), detail: str(cell.detail) };
    }
    out.push({ domain, checks });
  }
  return out;
}

/* ---------------------------------------------------- placement report --- */

export interface PlacementProviderRow {
  provider: string;
  placements: Record<string, number>;
}

export interface PlacementReport {
  campaignId: string;
  /** placement → fraction (0..1). */
  overallPct: Record<string, number>;
  providers: PlacementProviderRow[];
  totalInboxes: number;
  generatedAt: string;
}

function numericRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const n = numberOr(raw, Number.NaN);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

/**
 * Where a sent campaign actually landed. `null` means no seed test has
 * reported for this campaign yet — the server's 404, a REAL empty state,
 * distinct from the thrown 502/503 "service not configured".
 */
export async function fetchPlacementReport(
  campaignId: string,
): Promise<PlacementReport | null> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/inbox-reality/campaigns/${encodeURIComponent(campaignId)}`,
  );
  if (res.error) {
    if (res.error.status === 404) return null;
    throw new EvidenceError(res.error, "Couldn't load the placement report.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("placement report");
  const providers: PlacementProviderRow[] = [];
  for (const row of itemsOf(res.data.providers ?? [], "placement providers")) {
    if (!isRecord(row)) continue;
    const provider = str(row.provider).trim();
    if (!provider) continue;
    providers.push({ provider, placements: numericRecord(row.placements) });
  }
  return {
    campaignId: str(res.data.campaign_id, campaignId),
    overallPct: numericRecord(res.data.overall_pct),
    providers,
    totalInboxes: Math.max(0, numberOr(res.data.total_inboxes, 0)),
    generatedAt: str(res.data.generated_at),
  };
}

/* ------------------------------------------------------------ eq score --- */

export interface EqReason {
  code: string;
  message: string;
  severity: string;
  bucket: string;
}

export interface EqSubScore {
  score: number;
  weight: number;
  reasons: EqReason[];
}

export interface EqScoreResult {
  score: number;
  grade: string;
  content: EqSubScore;
  auth: EqSubScore;
  reputation: EqSubScore;
  reasons: EqReason[];
  /** Pillars the server refused to fabricate — render "not scored", never 0. */
  skippedSubScores: string[];
}

function parseReasons(value: unknown): EqReason[] {
  const out: EqReason[] = [];
  for (const row of itemsOf(value ?? [], "eq reasons")) {
    if (!isRecord(row)) continue;
    const message = str(row.message).trim();
    if (!message) continue;
    out.push({
      code: str(row.code),
      message,
      severity: str(row.severity, "info"),
      bucket: str(row.bucket),
    });
  }
  return out;
}

function parseSubScore(value: unknown): EqSubScore {
  const record = isRecord(value) ? value : {};
  return {
    score: Math.max(0, Math.min(100, numberOr(record.score, 0))),
    weight: numberOr(record.weight, 0),
    reasons: parseReasons(record.reasons),
  };
}

/** POST /api/v1/deliverability/eq-score — grade a draft's quality signals. */
export async function scoreEqDraft(input: {
  from: string;
  subject: string;
  html?: string;
  text?: string;
}): Promise<EqScoreResult> {
  const res = await rawRequest<unknown>(
    "POST",
    "/api/v1/deliverability/eq-score",
    {
      from: input.from,
      subject: input.subject,
      html: input.html ?? "",
      text: input.text ?? "",
    },
  );
  if (res.error) {
    throw new EvidenceError(res.error, "Couldn't score the draft.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("EQ score");
  return {
    score: Math.max(0, Math.min(100, numberOr(res.data.score, 0))),
    grade: str(res.data.grade),
    content: parseSubScore(res.data.content),
    auth: parseSubScore(res.data.auth),
    reputation: parseSubScore(res.data.reputation),
    reasons: parseReasons(res.data.reasons),
    skippedSubScores: Array.isArray(res.data.skippedSubScores)
      ? res.data.skippedSubScores.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  };
}
