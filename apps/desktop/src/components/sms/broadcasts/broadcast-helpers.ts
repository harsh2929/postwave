/**
 * broadcast-helpers — pure logic for the SMS Broadcasts surface
 * (BroadcastsPanel + BroadcastComposerModal).
 *
 * Kept in a plain .ts module (no JSX, type-only api-client imports) so
 * the node-environment vitest suite can import the real functions
 * instead of mirroring them (convention: sms-settings-helpers,
 * notifications-panel-helpers).
 *
 * Server source of truth: apps/api/internal/sms/{broadcasts,
 * broadcast_handlers,phone}.go. Two rules this module mirrors exactly:
 *
 *   1. Segment math — `smsSegmentInfo` is a 1:1 port of Go
 *      `SegmentCount` (phone.go): trimmed code-point count, GSM-ish
 *      bodies split 160/153, any code point > 127 flips the whole
 *      body to unicode 70/67. The composer counter and the server's
 *      `segments_per_message` column must never disagree.
 *
 *   2. Audience exclusivity — a broadcast targets EXACTLY ONE of
 *      list_ids | segment_id | tag (server 422 `invalid_audience`).
 *      The form enforces it structurally (one audience kind selected)
 *      and `buildBroadcastUpsert` explicitly clears the other two
 *      dimensions so a PATCH can never leave a stale second audience
 *      behind.
 */

import type {
  List,
  ListsResponse,
  SmsBroadcast,
  SmsBroadcastProgress,
  SmsBroadcastUpsert,
} from "../../../lib/api-client";

/* ---------- segment math (mirrors sms.SegmentCount) ---------------- */

export interface SmsSegmentInfo {
  /** Trimmed code-point count — what the server bills/segments on. */
  chars: number;
  /** 0 for an empty/whitespace body, exactly like the Go function. */
  segments: number;
  /** "gsm" (160/153) or "unicode" (70/67). */
  encoding: "gsm" | "unicode";
  /** Single-message capacity for this encoding (160 or 70). */
  singleLimit: number;
  /** Chars left before the CURRENT segment overflows into a new one. */
  remaining: number;
}

export function smsSegmentInfo(body: string): SmsSegmentInfo {
  const trimmed = body.trim();
  // Array.from iterates code points, matching Go's `range` over a string.
  // Do not use UTF-16 `.split("")`: it would count an emoji twice.
  const points = Array.from(trimmed);
  const unicode = points.some((p) => (p.codePointAt(0) ?? 0) > 127);
  const single = unicode ? 70 : 160;
  const concat = unicode ? 67 : 153;
  const chars = points.length;
  if (chars === 0) {
    return {
      chars: 0,
      segments: 0,
      encoding: unicode ? "unicode" : "gsm",
      singleLimit: single,
      remaining: single,
    };
  }
  const segments = chars <= single ? 1 : Math.ceil(chars / concat);
  const remaining =
    chars <= single ? single - chars : segments * concat - chars;
  return {
    chars,
    segments,
    encoding: unicode ? "unicode" : "gsm",
    singleLimit: single,
    remaining,
  };
}

/* ---------- audience -------------------------------------------------- */

export type BroadcastAudienceKind = "lists" | "segment" | "tag";

type AudienceFields = Pick<SmsBroadcast, "list_ids" | "segment_id" | "tag">;

/** Which audience dimension a stored broadcast row uses (null = none
 *  set yet — a draft saved before picking recipients). */
export function audienceKind(
  b: Partial<AudienceFields>,
): BroadcastAudienceKind | null {
  if ((b.list_ids ?? []).length > 0) return "lists";
  if ((b.segment_id ?? "") !== "") return "segment";
  if ((b.tag ?? "") !== "") return "tag";
  return null;
}

export interface AudienceNameLookup {
  listName?: (id: string) => string | undefined;
  segmentName?: (id: string) => string | undefined;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** One-line audience summary for the list table. Honest about unknown
 *  names (falls back to a shortened id rather than inventing one). */
export function audienceSummary(
  b: Partial<AudienceFields>,
  lookup: AudienceNameLookup = {},
): string {
  const kind = audienceKind(b);
  if (kind === "lists") {
    const ids = b.list_ids ?? [];
    const names = ids.map((id) => lookup.listName?.(id) ?? shortId(id));
    const shown = names.slice(0, 3).join(", ");
    const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
    return ids.length === 1
      ? `List: ${shown}`
      : `${ids.length} lists: ${shown}${extra}`;
  }
  if (kind === "segment") {
    const id = b.segment_id ?? "";
    return `Segment: ${lookup.segmentName?.(id) ?? shortId(id)}`;
  }
  if (kind === "tag") return `Tag: ${b.tag ?? ""}`;
  return "No audience yet";
}

/* ---------- composer form state -------------------------------------- */

export interface BroadcastFormState {
  name: string;
  body: string;
  senderProfileId: string;
  audience: BroadcastAudienceKind;
  listIds: string[];
  segmentId: string;
  tag: string;
  /** `datetime-local` input value ("" = no schedule). */
  scheduledAtLocal: string;
}

export function emptyBroadcastForm(): BroadcastFormState {
  return {
    name: "",
    body: "",
    senderProfileId: "",
    audience: "lists",
    listIds: [],
    segmentId: "",
    tag: "",
    scheduledAtLocal: "",
  };
}

export function formFromBroadcast(b: SmsBroadcast): BroadcastFormState {
  return {
    name: b.name,
    body: b.body,
    senderProfileId: b.sender_profile_id ?? "",
    audience: audienceKind(b) ?? "lists",
    listIds: [...(b.list_ids ?? [])],
    segmentId: b.segment_id ?? "",
    tag: b.tag ?? "",
    scheduledAtLocal: isoToLocalInput(b.scheduled_at ?? null),
  };
}

/**
 * Client-side validation mirroring the server's typed 422 codes
 * (name_required, body_required, invalid_audience/audience_required)
 * so the operator sees the same rule before the round-trip. Returns a
 * field → message map; empty map = valid.
 */
export function validateBroadcastForm(
  form: BroadcastFormState,
  now: Date = new Date(),
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) {
    errors.name = "Broadcast name is required.";
  }
  if (!form.body.trim()) {
    errors.body = "Message body is required.";
  }
  if (form.audience === "lists" && form.listIds.length === 0) {
    errors.audience = "Pick at least one SMS list.";
  } else if (form.audience === "segment" && !form.segmentId.trim()) {
    errors.audience = "Pick a segment.";
  } else if (form.audience === "tag" && !form.tag.trim()) {
    errors.audience = "Enter a tag.";
  }
  if (form.scheduledAtLocal !== "") {
    const iso = localInputToIso(form.scheduledAtLocal);
    if (!iso) {
      errors.schedule = "Enter a valid date and time.";
    } else if (new Date(iso).getTime() <= now.getTime()) {
      errors.schedule = "Scheduled time must be in the future.";
    }
  }
  return errors;
}

/**
 * Build the create/PATCH body. EXACTLY-ONE audience: the chosen
 * dimension is set and the other two are explicitly cleared (`[]` /
 * `""`) — the server applies every non-nil field, so omitting them on
 * a PATCH would leave a stale second audience and trip the 422
 * `invalid_audience` exclusivity check.
 */
export function buildBroadcastUpsert(
  form: BroadcastFormState,
): SmsBroadcastUpsert {
  return {
    name: form.name.trim(),
    body: form.body.trim(),
    sender_profile_id: form.senderProfileId.trim(),
    list_ids: form.audience === "lists" ? form.listIds : [],
    segment_id: form.audience === "segment" ? form.segmentId.trim() : "",
    tag: form.audience === "tag" ? form.tag.trim() : "",
    scheduled_at:
      form.scheduledAtLocal === ""
        ? null
        : localInputToIso(form.scheduledAtLocal),
  };
}

/* ---------- datetime-local <-> ISO ------------------------------------ */

/** Parse a `datetime-local` value (interpreted in the local zone) into
 *  RFC3339 UTC. Returns null for empty/invalid input. */
export function localInputToIso(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Format an ISO timestamp into the local `datetime-local` value
 *  ("YYYY-MM-DDTHH:MM"). Empty string for null/invalid input. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- status + action gates ------------------------------------- */

export interface StatusBadgeSpec {
  label: string;
  className: string;
}

/** Map a broadcast status onto the shared `.badge` classes. Unknown
 *  statuses render verbatim (render, don't switch — per the manifest). */
export function broadcastStatusBadge(status: string): StatusBadgeSpec {
  switch (status) {
    case "draft":
      return { label: "Draft", className: "badge" };
    case "scheduled":
      return { label: "Scheduled", className: "badge warning" };
    case "sending":
      return { label: "Sending…", className: "badge accent" };
    case "sent":
      return { label: "Sent", className: "badge accent" };
    case "cancelled":
      return { label: "Cancelled", className: "badge" };
    default:
      return { label: status || "—", className: "badge" };
  }
}

/** Send/Schedule available from draft|scheduled (the server claim
 *  flips exactly one of those to sending). */
export function canSendBroadcast(status: string): boolean {
  return status === "draft" || status === "scheduled";
}

/** Cancel per spec: scheduled|sending. (The server also accepts a
 *  draft cancel, but Delete is the draft affordance.) */
export function canCancelBroadcast(status: string): boolean {
  return status === "scheduled" || status === "sending";
}

/** Delete is draft-only in the UI (the server merely forbids deleting
 *  while sending; the tighter client gate keeps sent history intact). */
export function canDeleteBroadcast(status: string): boolean {
  return status === "draft";
}

/** PATCH is server-enforced draft|scheduled only. */
export function canEditBroadcast(status: string): boolean {
  return status === "draft" || status === "scheduled";
}

/* ---------- progress --------------------------------------------------- */

/** Percent complete (0..100). Held rows still count as "worked" — they
 *  are queued deliveries waiting for a quiet-hours window to end, not
 *  failures, so we exclude them from the completion numerator but keep
 *  them in the denominator (honest: a held broadcast is NOT done). */
export function progressPct(p: SmsBroadcastProgress): number {
  if (p.total <= 0) return 0;
  const done = p.sent + p.failed;
  return Math.max(0, Math.min(100, Math.round((done / p.total) * 100)));
}

/* ---------- typed errors ----------------------------------------------- */

export interface BroadcastApiError {
  message: string;
  status?: number;
  code?: string;
}

/** Pull the recipient cap out of the server's `audience_too_large`
 *  message ("…cap of 5000 recipients…"). Null when unparseable. */
export function extractAudienceCap(message: string): number | null {
  const m = message.match(/cap of (\d+) recipients/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Operator-facing copy for the typed error codes the broadcast
 * endpoints emit (broadcasts.go / broadcast_handlers.go). Unknown
 * codes fall back to the server message verbatim — never invent.
 */
export function describeBroadcastError(
  err: BroadcastApiError | undefined,
): string {
  if (!err) return "Something went wrong. Try again.";
  switch (err.code) {
    case "audience_too_large": {
      const cap = extractAudienceCap(err.message);
      return cap !== null
        ? `Audience too large — the per-broadcast cap is ${cap.toLocaleString()} recipients. Narrow the audience (fewer lists, a tighter segment) or raise the cap on the server.`
        : err.message;
    }
    case "no_consented_recipients":
      return "No opted-in recipients — this audience contains no phone numbers with SMS consent that aren't suppressed. Only opted-in, non-suppressed numbers receive broadcasts.";
    case "sms_provider_unconfigured":
      return "No SMS provider is configured on the server — configure one before sending broadcasts.";
    case "sms_broadcast_dispatch_release_held":
      return "SMS broadcast dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider send or schedule request was started.";
    case "sms_financial_reservation_unavailable":
      return "SMS broadcast dispatch is unavailable because durable financial reservation is unavailable. No provider send or schedule request was started.";
    case "sms_dispatch_worker_unavailable":
      return "SMS broadcast dispatch is unavailable because the dedicated SMS worker identity is unavailable. No provider send or schedule request was started.";
    case "sms_configured_sender_unavailable":
      return "SMS broadcast dispatch is unavailable because no configured sender is ready. No provider send or schedule request was started.";
    case "sender_paused":
      return "This sender is paused by the kill switch. Resume it before sending.";
    case "broadcast_sending":
      return "This broadcast is currently sending — cancel it first.";
    case "invalid_audience":
      return "Choose exactly one audience: lists, a segment, or a tag.";
    case "audience_required":
      return "Set an audience (lists, a segment, or a tag) before sending.";
    case "name_required":
      return "Broadcast name is required.";
    case "body_required":
      return "Message body is required.";
    case "sender_required":
      return "Pick a sender profile before sending.";
    case "invalid_sender":
      return "Sender profile id must be a UUID — re-pick the sender.";
    case "broadcast_not_found":
      return "Broadcast not found — it may have been deleted. Refresh the list.";
    default:
      return err.message;
  }
}

/** Which composer field a server 422 belongs to (so typed errors land
 *  inline next to the offending input, not in a generic banner). */
export function fieldForBroadcastErrorCode(
  code: string | undefined,
): "name" | "body" | "audience" | "sender" | "_form" {
  switch (code) {
    case "name_required":
      return "name";
    case "body_required":
      return "body";
    case "invalid_audience":
    case "audience_required":
    case "audience_too_large":
      return "audience";
    case "sender_required":
    case "invalid_sender":
      return "sender";
    default:
      return "_form";
  }
}

/* ---------- response unwrapping ---------------------------------------- */

/** Standard unwrap ladder for the Listmonk lists envelope
 *  (`{data:{results:[…]}}` | `{items}` | `{results}` | bare array). */
export function unwrapLists(payload: ListsResponse | undefined): List[] {
  if (!payload) return [];
  if (Array.isArray(payload.data)) return payload.data;
  const nested = payload.data?.results;
  if (Array.isArray(nested)) return nested;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;
  return [];
}
