/**
 * lib/lookalikeAudiences.ts — the wire shapes of a first-party lookalike
 * audience, and the constants that decide what its numbers MEAN.
 *
 * Import-free by construction so every decision below is unit-testable in the
 * node vitest environment (house rule 6). Nothing here was taken from
 * openapi.json; every fact is cited to the Go source or the migration.
 *
 * THERE ARE TWO LOOKALIKE FAMILIES AND ONLY ONE CAN BACK A MONITOR. This is
 * the load-bearing choice on this surface, so it is stated first:
 *
 *   FAMILY A — /api/v1/audiences/lookalike (audiences/handlers.go:37-45) is
 *   POST create, GET /{id}, GET /{id}/members, DELETE /{id}. It has NO LIST
 *   ROUTE. A monitor built on it would have nothing to open: the only way to
 *   reach a model is to already hold its id, which on a phone means never.
 *
 *   FAMILY B — /api/v1/subscribers/lookalike (subscribers/lookalike.go:461-471)
 *   adds `GET /api/v1/subscribers/lookalike` returning every saved audience
 *   newest-first (`ListLookalikes`, lookalike.go:198). That list is what makes
 *   this surface possible, so Family B is the one this module models. Both are
 *   live (main.go:2373 mounts A; subscriber_lists_segments.go:139 mounts B) and
 *   they persist to SEPARATE tables — migrations 0949/0950 for B — so the two
 *   sets of saved audiences genuinely do not overlap.
 *
 * SIX FACTS FROM THE HANDLER THAT SHAPE EVERY FIELD BELOW:
 *
 *  1. THE LIST ROW IS THE WHOLE HEADER. `ListLookalikes` and `GetLookalike`
 *     select the IDENTICAL fourteen columns (lookalike.go:206-211 vs :250-255),
 *     so a detail fetch adds exactly nothing unless it asks for members. That
 *     is why this surface makes one request for the catalogue and only reaches
 *     for a second when a human explicitly asks to see people.
 *  2. MEMBERS ARE PII AND ARE OPT-IN ON THE WIRE. `GetLookalike` returns an
 *     EMPTY members array unless `include_pii=true` (lookalike.go:262), and the
 *     type comment says why: "a status poll cannot accidentally hydrate
 *     subscriber PII" (types.go:478-481). The mobile surface mirrors that
 *     contract rather than defeating it.
 *  3. CREATE IS SYNCHRONOUS AND ALWAYS LANDS 'ready'. The insert hardcodes
 *     `'ready'` (lookalike.go:169) after ranking inline. But the column's CHECK
 *     admits 'pending' | 'running' | 'failed' too (migration 0949), and the
 *     migration says the status exists "so a future async generator can report
 *     progress". So a non-ready row is possible and must never be rendered as a
 *     finished audience — see lib/lookalikeHealth.
 *  4. THE MODEL IS A FROZEN SNAPSHOT. Members are materialised once, at create
 *     (lookalike.go:182-196). There is no refresh route and no scheduler
 *     anywhere in the package: the audience ages while the seed segment moves.
 *  5. THE POOLS ARE CAPPED. The seed sample is capped at 20,000
 *     (`LookalikeSeedSampleCap`) and the candidate scan at 50,000
 *     (`LookalikeCandidatePoolCap`, lookalike.go:52-59). A tenant larger than
 *     the cap had subscribers that were never scored at all.
 *  6. `Rank` TRUNCATES TO THE REQUESTED SIZE (predictive/similarity.go:177-179).
 *     So `member_count == size_requested` means the model hit its ceiling, and
 *     `member_count < size_requested` means the eligible pool ran out — a real
 *     shortfall, not a rounding artefact.
 *
 * ABSENCE IS NOT ZERO. Every count is `number | null`: the columns are NOT NULL
 * in the table, so a genuine 0 is meaningful, and a missing or non-numeric
 * field is a different claim that must render as an em-dash.
 */

/** `MinLookalikeSize` / `MaxLookalikeSize` / `DefaultLookalikeSize`. */
export const LOOKALIKE_MIN_SIZE = 100;
export const LOOKALIKE_MAX_SIZE = 10_000;
export const LOOKALIKE_DEFAULT_SIZE = 1_000;

/** `MinLookalikeSeedMembers` — a seed below this is refused outright. */
export const LOOKALIKE_MIN_SEED_MEMBERS = 50;

/** `MinLookalikeConfidence` — the floor a supplied threshold must clear. */
export const LOOKALIKE_MIN_CONFIDENCE = 0.5;

/** `LookalikeSeedSampleCap` — seed members that feed the centroid. */
export const LOOKALIKE_SEED_SAMPLE_CAP = 20_000;

/** `LookalikeCandidatePoolCap` — non-seed subscribers the ranker scores. */
export const LOOKALIKE_CANDIDATE_POOL_CAP = 50_000;

/**
 * `lookalikeBands` band edges (lookalike.go:419-432). A member scoring below
 * 0.5 is in the LOW band and was only included because the audience was built
 * with no confidence floor.
 */
export const LOOKALIKE_BAND_HIGH_MIN = 0.8;
export const LOOKALIKE_BAND_MEDIUM_MIN = 0.5;

/**
 * How many ranked members the phone asks for when someone opts in. The handler
 * accepts up to 1,000 per page, but this is a SAMPLE for judging quality, not
 * a directory — paging a 10,000-row modeled audience on a phone is not a task.
 */
export const LOOKALIKE_MEMBER_SAMPLE_SIZE = 25;

/** `subscriber_lookalike_audiences.status` CHECK set (migration 0949). */
export const LOOKALIKE_STATUSES = [
  "pending",
  "running",
  "ready",
  "failed",
] as const;
export type LookalikeStatus = (typeof LOOKALIKE_STATUSES)[number];

/** Similarity band names, from most to least similar. */
export type LookalikeBand = "high" | "medium" | "low";

/**
 * The `payload.bands` breakdown. Each band is nullable: `lookalikeBands` always
 * writes all three, but `payload` is free-form jsonb and an older or
 * differently-generated row may carry none of them. A missing band is UNKNOWN,
 * never zero.
 */
export interface LookalikeBands {
  high: number | null;
  medium: number | null;
  low: number | null;
}

/** One saved lookalike audience header, flattened with its payload stats. */
export interface LookalikeAudience {
  id: string;
  name: string;
  seedSegmentId: string;
  /** The size the operator ASKED for. `Rank` truncates to it. */
  sizeRequested: number | null;
  /** The size the model actually materialised. */
  memberCount: number | null;
  /** Seed members that fed the centroid, capped at 20,000. */
  seedCount: number | null;
  /** The confidence floor, or null for "keep everything the ranker scored". */
  confidenceThreshold: number | null;
  modelVersion: string;
  /** Null when the server sent a status this build does not recognise. */
  status: LookalikeStatus | null;
  /** Raw status string, kept so an unrecognised one can be shown verbatim. */
  rawStatus: string;
  /**
   * Set once someone associated this audience with an `audience_destinations`
   * row. It does NOT mean anything was delivered — see `ExportLookalike`
   * (lookalike.go:322-324), which explicitly "does not start provider
   * delivery".
   */
  exportedDestinationId: string | null;
  error: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** `payload.bands` — the similarity histogram. */
  bands: LookalikeBands;
  /** `payload.candidate_count` — non-seed subscribers actually scored. */
  candidateCount: number | null;
  /** `payload.scored` — how many survived the floor and the size cap. */
  scored: number | null;
  /** `payload.feature_dims` — the first-party dimensions the model used. */
  featureDims: string[];
  /** `payload.data_use_notice_version` — the acknowledgement on record. */
  dataUseNoticeVersion: string | null;
}

/**
 * One ranked member, with the two NUMERIC features pulled out of the feature
 * vector. `vectorize` (predictive/similarity.go:66-81) emits exactly four kinds
 * of key: `domain:<host>` and `source:<name>` are one-hot and are only present
 * when the seed itself exhibits that value, plus `engagement` and `retention`
 * scaled into [0,1] — retention being inverted churn, not a stored column.
 */
export interface LookalikeMember {
  subscriberId: string;
  email: string;
  similarityScore: number | null;
  rank: number | null;
  engagement: number | null;
  retention: number | null;
  /** The seed-shared email domain that contributed, if any. */
  matchedDomain: string | null;
  /** The seed-shared signup source that contributed, if any. */
  matchedSource: string | null;
}

/** `LookalikeAudienceDetail` — the header plus one page of ranked members. */
export interface LookalikeMemberPage {
  audience: LookalikeAudience | null;
  members: LookalikeMember[];
  page: number;
  perPage: number;
  /** False whenever the caller did not pass `include_pii=true`. */
  piiIncluded: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseStatus(raw: string): LookalikeStatus | null {
  return (LOOKALIKE_STATUSES as readonly string[]).includes(raw)
    ? (raw as LookalikeStatus)
    : null;
}

function parseBands(raw: unknown): LookalikeBands {
  const bands = record(raw);
  return {
    high: nullableNum(bands.high),
    medium: nullableNum(bands.medium),
    low: nullableNum(bands.low),
  };
}

function parseFeatureDims(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

/** Returns null for anything without an id — an unidentifiable row is noise. */
export function parseLookalikeAudience(raw: unknown): LookalikeAudience | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = row.id == null ? "" : String(row.id);
  if (!id) return null;
  const payload = record(row.payload);
  const rawStatus = str(row.status);
  return {
    id,
    name: str(row.name),
    seedSegmentId: str(row.seed_segment_id),
    sizeRequested: nullableNum(row.size_requested),
    memberCount: nullableNum(row.member_count),
    seedCount: nullableNum(row.seed_count) ?? nullableNum(payload.seed_count),
    confidenceThreshold: nullableNum(row.confidence_threshold),
    modelVersion: str(row.model_version),
    status: parseStatus(rawStatus),
    rawStatus,
    exportedDestinationId: nullableStr(row.exported_destination_id),
    error: str(row.error),
    createdAt: nullableStr(row.created_at),
    updatedAt: nullableStr(row.updated_at),
    bands: parseBands(payload.bands),
    candidateCount: nullableNum(payload.candidate_count),
    scored: nullableNum(payload.scored),
    featureDims: parseFeatureDims(payload.feature_dims),
    dataUseNoticeVersion: nullableStr(payload.data_use_notice_version),
  };
}

/**
 * `ListLookalikes` returns `{items:[...]}` (types.go:466-469). The bare-array
 * form is accepted too so this keeps working if the envelope is ever dropped —
 * the same defence lib/segments carries, and for the same reason: guessing
 * wrong here renders a populated workspace as empty.
 */
export function parseLookalikeAudienceList(res: unknown): LookalikeAudience[] {
  const rows = Array.isArray(res)
    ? res
    : Array.isArray((res as { items?: unknown[] } | undefined)?.items)
      ? (res as { items: unknown[] }).items
      : [];
  const out: LookalikeAudience[] = [];
  for (const raw of rows) {
    const parsed = parseLookalikeAudience(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Pulls the numeric features out of the one-hot + scalar feature vector. */
export function parseLookalikeMember(raw: unknown): LookalikeMember | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const subscriberId = row.subscriber_id == null ? "" : String(row.subscriber_id);
  if (!subscriberId) return null;
  const features = record(row.features);
  let matchedDomain: string | null = null;
  let matchedSource: string | null = null;
  for (const key of Object.keys(features)) {
    if (matchedDomain === null && key.startsWith("domain:")) {
      matchedDomain = key.slice("domain:".length) || null;
    } else if (matchedSource === null && key.startsWith("source:")) {
      matchedSource = key.slice("source:".length) || null;
    }
  }
  return {
    subscriberId,
    email: str(row.email),
    similarityScore: nullableNum(row.similarity_score),
    rank: nullableNum(row.rank),
    engagement: nullableNum(features.engagement),
    retention: nullableNum(features.retention),
    matchedDomain,
    matchedSource,
  };
}

/**
 * `GetLookalike` answers `{audience, members, page, per_page, pii_included}`.
 * `piiIncluded` is echoed rather than assumed: it is the server's own statement
 * about whether the array it sent is "no members" or "members withheld", and
 * conflating those two would let this screen tell an operator a 4,000-member
 * audience is empty.
 */
export function parseLookalikeMemberPage(res: unknown): LookalikeMemberPage {
  const row = record(res);
  const rawMembers = Array.isArray(row.members) ? row.members : [];
  const members: LookalikeMember[] = [];
  for (const raw of rawMembers) {
    const parsed = parseLookalikeMember(raw);
    if (parsed) members.push(parsed);
  }
  return {
    audience: parseLookalikeAudience(row.audience),
    members,
    page: nullableNum(row.page) ?? 1,
    perPage: nullableNum(row.per_page) ?? LOOKALIKE_MEMBER_SAMPLE_SIZE,
    piiIncluded: row.pii_included === true,
  };
}

/** Which band a similarity score falls in. Null for an absent score. */
export function bandOf(score: number | null): LookalikeBand | null {
  if (score === null) return null;
  if (score >= LOOKALIKE_BAND_HIGH_MIN) return "high";
  if (score >= LOOKALIKE_BAND_MEDIUM_MIN) return "medium";
  return "low";
}

/** Display name, never an empty string and never a bare uuid. */
export function lookalikeName(audience: LookalikeAudience): string {
  return audience.name.trim() || "Untitled lookalike";
}
