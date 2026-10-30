// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure logic for the SMS Broadcasts tab (SmsBroadcastsCard +
 * SmsBroadcastComposerDialog). No JSX and no transport so node-environment
 * tests import the real functions.
 *
 * Server source of truth: apps/api/internal/sms/{broadcasts,
 * broadcast_handlers,phone}.go. Two rules mirrored exactly:
 *
 *   1. Segment math — `smsBroadcastSegmentInfo` ports Go `SegmentCount`:
 *      GSM-7 bodies count septets (extension characters cost two) and split
 *      160/153; any other character switches the whole body to UCS-2, counted
 *      in UTF-16 code units and split 70/67. The composer counter and the
 *      stored `segments_per_message` must never disagree.
 *
 *   2. Audience exclusivity — a broadcast targets EXACTLY ONE of
 *      list_ids | segment_id | tag (server 422 `invalid_audience`).
 *      `buildSmsBroadcastUpsert` clears the two unchosen dimensions so a PATCH
 *      can never leave a stale second audience behind.
 */

import type { Segment } from "@/lib/segments-api";
import type {
  SmsBroadcast,
  SmsBroadcastProgress,
  SmsBroadcastUpsert,
  SmsList,
} from "@/lib/sms-api";

/* ---------- segment math (mirrors sms.SegmentCount) ---------------------- */

/** Server hard-rejects bodies over this many segments (422 too_many_segments). */
export const SMS_BROADCAST_SEGMENT_CAP = 10;

const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENSION = "^{}\\[~]|€\f";

export interface SmsBroadcastSegmentInfo {
  /** Billable units: GSM-7 septets or UTF-16 code units. */
  units: number;
  /** 0 for an empty/whitespace body, exactly like the Go function. */
  segments: number;
  encoding: "gsm7" | "ucs2";
  singleLimit: number;
  /** Units left before the CURRENT segment overflows into a new one. */
  remaining: number;
}

export function smsBroadcastSegmentInfo(body: string): SmsBroadcastSegmentInfo {
  // The server trims the body before storing and counting.
  const text = body.trim();
  if (!text) {
    return {
      units: 0,
      segments: 0,
      encoding: "gsm7",
      singleLimit: 160,
      remaining: 160,
    };
  }
  let septets = 0;
  let gsm7 = true;
  for (const char of text) {
    if (GSM7_BASIC.includes(char)) septets += 1;
    else if (GSM7_EXTENSION.includes(char)) septets += 2;
    else {
      gsm7 = false;
      break;
    }
  }
  // UCS-2 accounting is per UTF-16 code unit (astral characters cost two),
  // which is exactly what `String.prototype.length` counts.
  const units = gsm7 ? septets : text.length;
  const single = gsm7 ? 160 : 70;
  const concat = gsm7 ? 153 : 67;
  const segments = units <= single ? 1 : Math.ceil(units / concat);
  const remaining =
    units <= single ? single - units : segments * concat - units;
  return {
    units,
    segments,
    encoding: gsm7 ? "gsm7" : "ucs2",
    singleLimit: single,
    remaining,
  };
}

/* ---------- audience ------------------------------------------------------ */

export type SmsBroadcastAudienceKind = "lists" | "segment" | "tag";

type AudienceFields = Pick<SmsBroadcast, "list_ids" | "segment_id" | "tag">;

/** Which audience dimension a stored row uses (null = none chosen yet). */
export function smsBroadcastAudienceKind(
  broadcast: Partial<AudienceFields>,
): SmsBroadcastAudienceKind | null {
  if ((broadcast.list_ids ?? []).length > 0) return "lists";
  if ((broadcast.segment_id ?? "") !== "") return "segment";
  if ((broadcast.tag ?? "") !== "") return "tag";
  return null;
}

export interface SmsBroadcastAudienceLookup {
  lists?: readonly Pick<SmsList, "id" | "name">[];
  segments?: readonly Pick<Segment, "id" | "name">[];
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** One-line audience summary. Unknown names fall back to a shortened id
 *  rather than an invented name. */
export function smsBroadcastAudienceSummary(
  broadcast: Partial<AudienceFields>,
  lookup: SmsBroadcastAudienceLookup = {},
): string {
  const kind = smsBroadcastAudienceKind(broadcast);
  if (kind === "lists") {
    const ids = broadcast.list_ids ?? [];
    const names = ids.map(
      (id) => lookup.lists?.find((list) => list.id === id)?.name ?? shortId(id),
    );
    const shown = names.slice(0, 3).join(", ");
    const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
    return ids.length === 1
      ? `List: ${shown}`
      : `${ids.length} lists: ${shown}${extra}`;
  }
  if (kind === "segment") {
    const id = broadcast.segment_id ?? "";
    return `Segment: ${
      lookup.segments?.find((segment) => segment.id === id)?.name ?? shortId(id)
    }`;
  }
  if (kind === "tag") return `Tag: ${broadcast.tag ?? ""}`;
  return "No audience yet";
}

/* ---------- composer form state -------------------------------------------- */

export interface SmsBroadcastFormState {
  name: string;
  body: string;
  senderProfileId: string;
  audience: SmsBroadcastAudienceKind;
  listIds: string[];
  segmentId: string;
  tag: string;
  /** `datetime-local` input value ("" = no schedule). */
  scheduledAtLocal: string;
}

export type SmsBroadcastFormField =
  | "name"
  | "body"
  | "sender"
  | "audience"
  | "schedule"
  | "_form";

export function emptySmsBroadcastForm(): SmsBroadcastFormState {
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

export function smsBroadcastFormFrom(
  broadcast: SmsBroadcast,
): SmsBroadcastFormState {
  return {
    name: broadcast.name,
    body: broadcast.body,
    senderProfileId: broadcast.sender_profile_id ?? "",
    audience: smsBroadcastAudienceKind(broadcast) ?? "lists",
    listIds: [...(broadcast.list_ids ?? [])],
    segmentId: broadcast.segment_id ?? "",
    tag: broadcast.tag ?? "",
    scheduledAtLocal: smsIsoToLocalInput(broadcast.scheduled_at ?? null),
  };
}

/**
 * Client-side pre-check of the server's typed 422 rules (name_required,
 * body_required, invalid_audience, too_many_segments) so the operator sees
 * the rule before the round-trip. The server remains authoritative; its
 * sentence is rendered verbatim whenever it disagrees.
 */
export function validateSmsBroadcastForm(
  form: SmsBroadcastFormState,
  now: Date = new Date(),
): Partial<Record<SmsBroadcastFormField, string>> {
  const errors: Partial<Record<SmsBroadcastFormField, string>> = {};
  if (!form.name.trim()) errors.name = "Broadcast name is required.";
  const segments = smsBroadcastSegmentInfo(form.body);
  if (!form.body.trim()) {
    errors.body = "Message body is required.";
  } else if (segments.segments > SMS_BROADCAST_SEGMENT_CAP) {
    errors.body = `Message is too long: SMS broadcasts are capped at ${SMS_BROADCAST_SEGMENT_CAP} segments and this message is ${segments.segments}.`;
  }
  if (form.audience === "lists" && form.listIds.length === 0) {
    errors.audience = "Pick at least one SMS list.";
  } else if (form.audience === "segment" && !form.segmentId.trim()) {
    errors.audience = "Pick a segment.";
  } else if (form.audience === "tag" && !form.tag.trim()) {
    errors.audience = "Enter a tag.";
  }
  if (form.scheduledAtLocal !== "") {
    const iso = smsLocalInputToIso(form.scheduledAtLocal);
    if (!iso) {
      errors.schedule = "Enter a valid date and time.";
    } else if (new Date(iso).getTime() <= now.getTime()) {
      errors.schedule = "Scheduled time must be in the future.";
    }
  }
  return errors;
}

/**
 * Build the create/PATCH body. EXACTLY-ONE audience: the chosen dimension is
 * set and the other two are explicitly cleared (`[]` / `""`).
 */
export function buildSmsBroadcastUpsert(
  form: SmsBroadcastFormState,
): SmsBroadcastUpsert {
  return {
    name: form.name.trim(),
    body: form.body.trim(),
    sender_profile_id: form.senderProfileId.trim(),
    list_ids: form.audience === "lists" ? [...form.listIds] : [],
    segment_id: form.audience === "segment" ? form.segmentId.trim() : "",
    tag: form.audience === "tag" ? form.tag.trim() : "",
    scheduled_at:
      form.scheduledAtLocal === ""
        ? null
        : smsLocalInputToIso(form.scheduledAtLocal),
  };
}

/* ---------- datetime-local <-> ISO ----------------------------------------- */

/** Parse a `datetime-local` value (local zone) into RFC3339 UTC; null when
 *  empty or invalid. */
export function smsLocalInputToIso(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Format an ISO timestamp as a local `datetime-local` value
 *  ("YYYY-MM-DDTHH:MM"); "" for null/invalid input. */
export function smsIsoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ---------- status + action gates ------------------------------------------ */

export type SmsBroadcastBadgeVariant =
  | "secondary"
  | "warning"
  | "info"
  | "success"
  | "outline";

/** Map a status onto a Badge variant. Unknown statuses render verbatim. */
export function smsBroadcastStatusBadge(status: string): {
  label: string;
  variant: SmsBroadcastBadgeVariant;
} {
  switch (status) {
    case "draft":
      return { label: "Draft", variant: "secondary" };
    case "scheduled":
      return { label: "Scheduled", variant: "warning" };
    case "sending":
      return { label: "Sending", variant: "info" };
    case "sent":
      return { label: "Sent", variant: "success" };
    case "cancelled":
      return { label: "Cancelled", variant: "outline" };
    default:
      return { label: status || "—", variant: "outline" };
  }
}

/** PATCH is server-enforced draft|scheduled only (409 broadcast_not_editable). */
export function canEditSmsBroadcast(status: string): boolean {
  return status === "draft" || status === "scheduled";
}

/** Cancel stops a scheduled or mid-send broadcast. (The server also accepts
 *  a draft cancel, but Delete is the draft affordance.) */
/** Send now / Schedule per spec: draft|scheduled (desktop canSendBroadcast). */
export function canSendSmsBroadcast(status: string): boolean {
  return status === "draft" || status === "scheduled";
}

/** A future scheduled_at turns "Send now" into "Schedule" (server arms it). */
export function smsBroadcastArmsLater(
  broadcast: Pick<SmsBroadcast, "scheduled_at">,
  now: number = Date.now(),
): boolean {
  return Boolean(
    broadcast.scheduled_at &&
      new Date(broadcast.scheduled_at).getTime() > now,
  );
}

export const SMS_BROADCAST_DISPATCH_RELEASE_HOLD_COPY =
  "SMS broadcast dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. Drafts remain editable, but no provider send or schedule request can be started.";

/** Disabled-Send reason keyed on the list payload's unavailable code (desktop dispatchHoldCopy). */
export function smsBroadcastDispatchHoldCopy(
  reason: string | null | undefined,
): string {
  if (reason === "sms_broadcast_dispatch_release_held") {
    return SMS_BROADCAST_DISPATCH_RELEASE_HOLD_COPY;
  }
  if (reason === "sms_financial_reservation_unavailable") {
    return "SMS broadcast dispatch is unavailable because durable financial reservation is unavailable. Drafts remain editable, but no provider send or schedule request can be started.";
  }
  return "SMS broadcast dispatch is unavailable. Drafts remain editable, but no provider send or schedule request can be started.";
}

export function canCancelSmsBroadcast(status: string): boolean {
  return status === "scheduled" || status === "sending";
}

/** The server refuses deletion only while sending (409 broadcast_sending). */
export function canDeleteSmsBroadcast(status: string): boolean {
  return status !== "sending";
}

/* ---------- progress ------------------------------------------------------- */

/** Percent of recipients accepted or recorded failed (0..100). Held rows are
 *  queued deliveries waiting out quiet hours — not done, so they stay in the
 *  denominator only. */
export function smsBroadcastProgressPct(progress: SmsBroadcastProgress): number {
  if (progress.total <= 0) return 0;
  const done = progress.sent + progress.failed;
  return Math.max(0, Math.min(100, Math.round((done / progress.total) * 100)));
}

/* ---------- typed errors --------------------------------------------------- */

/** Machine code off a transport error, when the server sent one. */
export function smsBroadcastErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code ? code : undefined;
}

/** Which composer field a server 422 belongs to, so the server's sentence
 *  lands next to the offending input instead of a generic banner. */
export function smsBroadcastFieldForErrorCode(
  code: string | undefined,
): SmsBroadcastFormField {
  switch (code) {
    case "name_required":
    case "invalid_name":
      return "name";
    case "body_required":
    case "sms_body_outside_contract":
    case "too_many_segments":
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
