// SPDX-License-Identifier: AGPL-3.0-only
//
// Subscriber drill-down "deep profile" endpoints: canonical segment/group
// membership, notes, per-channel consent, predictions, audit/attribute
// history, cross-channel timeline, and DSAR receipts. Backend:
// apps/api/internal/subscribers/*.go + subscriber_notes/ + send_time_opt/.

import { api, fetchTextAuthed } from "./api";
import { isExactSubscriberVersion } from "./subscribers-api";

const enc = encodeURIComponent;
const basePath = (id: string) => `/api/v1/subscribers/${enc(id)}`;

/* ------------------------- Segment / group membership --------------------- */

export interface SegmentMembership {
  segment_id: string;
  segment_name: string;
  is_member: boolean;
  matched_count: number;
  total_conditions: number;
  summary: string;
}

export interface GroupMembership {
  group_id: string;
  category: string;
  name: string;
  type: string;
  joined_at?: string;
}

export function getSegmentMembership(
  id: string,
): Promise<{ subscriber_id: string; segments: SegmentMembership[] }> {
  return api.get(`${basePath(id)}/segment-membership`);
}

export function getGroupMembership(
  id: string,
): Promise<{ subscriber_id: string; groups: GroupMembership[] }> {
  return api.get(`${basePath(id)}/groups`);
}

/* --------------------------------- Notes ---------------------------------- */

export interface SubscriberNoteMention {
  user_id: string;
  display: string;
}

/** Mirrors `subscriber_notes.Attachment`; `download_url` is a short-lived presign. */
export interface SubscriberNoteAttachment {
  id: string;
  note_id: string;
  file_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_by_user_id?: string;
  uploaded_by_email?: string;
  uploaded_at: string;
  download_url?: string;
}

export interface SubscriberNote {
  id: string;
  subscriber_id: string;
  body: string;
  markdown_body: string;
  mentions: SubscriberNoteMention[];
  attachments?: SubscriberNoteAttachment[];
  author_user_id?: string;
  author_email?: string;
  pinned: boolean;
  created_at: string;
}

export function listSubscriberNotes(
  id: string,
): Promise<{ notes: SubscriberNote[]; count: number }> {
  return api.get(`${basePath(id)}/notes`);
}

export function createSubscriberNote(
  id: string,
  input: { markdown_body: string; pinned?: boolean },
): Promise<{ id: string }> {
  return api.post(`${basePath(id)}/notes`, input);
}

export function updateSubscriberNote(
  id: string,
  noteId: string,
  input: { pinned?: boolean; markdown_body?: string },
): Promise<{ pinned?: boolean; markdown_body?: string }> {
  return api.patch(`${basePath(id)}/notes/${enc(noteId)}`, input);
}

export function deleteSubscriberNote(
  id: string,
  noteId: string,
): Promise<void> {
  return api.delete(`${basePath(id)}/notes/${enc(noteId)}`);
}

/** Mirrors `subscriber_notes.markdownBodyMax`. */
export const SUBSCRIBER_NOTE_MAX_CHARS = 20_000;

/**
 * Mention tokens exactly as the server's extractor parses them:
 * `@[Display](user:<uuid>)`. Display text may not contain `]`.
 */
export const NOTE_MENTION_TOKEN_RE =
  /@\[([^\]]{1,200})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

const MENTION_USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NoteMentionCandidate {
  id: string;
  display: string;
}

/** The inline token for one teammate, with `]` removed from the label. */
export function buildNoteMentionToken(candidate: NoteMentionCandidate): string {
  const display =
    candidate.display
      .replaceAll("]", "")
      .replaceAll("\n", " ")
      .trim()
      .slice(0, 200) || candidate.id;
  return `@[${display}](user:${candidate.id.toLowerCase()})`;
}

/**
 * Teammates the composer can @-mention: the workspace roster when the caller
 * can read it, plus every identity already present in this subscriber's note
 * history (the same local directory desktop builds), de-duplicated by id.
 */
export function buildNoteMentionCandidates(
  notes: readonly SubscriberNote[],
  roster: readonly { id: string; email: string }[],
): NoteMentionCandidate[] {
  const byId = new Map<string, NoteMentionCandidate>();
  const add = (rawId: string | undefined, display: string | undefined) => {
    if (!rawId || !MENTION_USER_ID_RE.test(rawId)) return;
    const id = rawId.toLowerCase();
    const label = (display ?? "").trim();
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, display: label || id });
    } else if (existing.display === id && label) {
      existing.display = label;
    }
  };
  for (const member of roster) add(member.id, member.email);
  for (const note of notes) {
    add(note.author_user_id, note.author_email);
    for (const mention of Array.isArray(note.mentions) ? note.mentions : []) {
      add(mention.user_id, mention.display);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.display.localeCompare(right.display),
  );
}

/**
 * Edits a note's markdown source. The server re-derives the plain projection
 * and the mention set from the new markdown, so mentions added or removed in
 * the edit take effect with it.
 */
export async function editSubscriberNote(
  subscriberId: string,
  noteId: string,
  markdownBody: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ markdown_body: string }> {
  const markdown = markdownBody.trim();
  if (!markdown) throw new Error("A note cannot be empty.");
  if (markdown.length > SUBSCRIBER_NOTE_MAX_CHARS) {
    throw new Error("Notes are capped at 20,000 characters.");
  }
  const value = await api.patch<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/notes/${encodeURIComponent(noteId)}`,
    { markdown_body: markdown },
    {
      requireOnline: true,
      idempotencyKey: `subscriber-note-edit:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
      signal: options.signal,
    },
  );
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { markdown_body?: unknown }).markdown_body !== "string"
  ) {
    throw new Error("The notes service did not confirm the edited text.");
  }
  return { markdown_body: (value as { markdown_body: string }).markdown_body };
}

/**
 * Server release hold on NEW attachments (`note_attachment_upload_unavailable`
 * — the POST answers a stable 503). Desktop renders the same disabled control.
 */
export const NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON =
  "Secure note uploads are unavailable until Moosewave can verify object ownership and scan the uploaded bytes. Existing authorized attachments remain readable.";

const ATTACHMENT_FILENAME_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** Attachment metadata is untrusted: keep control/bidi characters out of labels. */
export function displayNoteAttachmentFilename(filename: string): string {
  return (
    filename.replace(ATTACHMENT_FILENAME_CONTROLS, "").trim() || "Attachment"
  );
}

/**
 * The presigned download link, only when it is an absolute https URL (or http
 * on a loopback dev object store). Anything else is not rendered as a link.
 */
export function noteAttachmentDownloadUrl(
  attachment: Pick<SubscriberNoteAttachment, "download_url">,
): string | null {
  const raw = attachment.download_url?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.toString();
    if (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Whether a stored object key can be addressed as the `{file_key}` segment.
 *
 * The route is `{file_key:.+}`, so a `tenants/{tenant}/…` key travels with its
 * slashes as path separators (see {@link noteAttachmentKeyPath}). The API routes
 * on the RAW path whenever the URL carries an escape, so a segment that needs
 * percent-encoding is compared to the stored key still encoded and removes
 * nothing; every segment must therefore encode to itself. Empty, `.` and `..`
 * segments are refused because the browser collapses them before sending.
 */
export function noteAttachmentKeyAddressable(fileKey: string): boolean {
  if (fileKey.length === 0 || fileKey.length > 1024) return false;
  return fileKey
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        encodeURIComponent(segment) === segment,
    );
}

/**
 * The `{file_key:.+}` tail of the remove route: each `/`-separated segment
 * encoded, the separators kept — the same shape desktop sends. Reviewed as a
 * multi-segment path sanitizer by the mounted-route guard
 * (src/__tests__/helpers/client-route-audit.ts); call it only as the final
 * path segment, and only for keys {@link noteAttachmentKeyAddressable} accepts.
 */
export function noteAttachmentKeyPath(fileKey: string): string {
  return fileKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export const NOTE_ATTACHMENT_REMOVE_UNADDRESSABLE_REASON =
  "This attachment's storage path can't be addressed from the web app yet. Remove it from the Moosewave desktop app.";

export async function removeSubscriberNoteAttachment(
  subscriberId: string,
  noteId: string,
  fileKey: string,
): Promise<void> {
  if (!noteAttachmentKeyAddressable(fileKey)) {
    throw new Error(NOTE_ATTACHMENT_REMOVE_UNADDRESSABLE_REASON);
  }
  await api.delete(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/notes/${encodeURIComponent(noteId)}/attachments/${noteAttachmentKeyPath(fileKey)}`,
    {
      requireOnline: true,
      idempotencyKey: `subscriber-note-attachment-remove:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
    },
  );
}

/* --------------------------- Per-channel consent -------------------------- */

export type ConsentChannel = "email" | "sms" | "push" | "whatsapp" | "rcs";
export type ChannelConsentStatus =
  | "opted_in"
  | "opted_out"
  | "pending"
  | "unknown";

export interface ChannelConsent {
  id: string;
  subscriber_id: string;
  channel: ConsentChannel;
  status: ChannelConsentStatus;
  consent_timestamp?: string | null;
  consent_source: string;
  frequency_cap_until?: string | null;
  email?: string;
  phone_e164?: string;
  created_at: string;
  updated_at: string;
  subscriber_version?: string;
}

export interface ChannelConsentPage {
  items: ChannelConsent[];
  subscriber_version: string;
}

export interface ConsentEvidenceInput {
  status: "opted_in" | "opted_out";
  consent_source:
    | "double_optin"
    | "single_optin"
    | "preference_center"
    | "signed_form"
    | "direct_request";
  consent_timestamp: string;
  evidence_channel: "web" | "mobile" | "desktop" | "email" | "import" | "api";
  legal_basis:
    | "consent"
    | "contract"
    | "legitimate_interest"
    | "legal_obligation";
  evidence: string;
  jurisdiction: string;
  reason: string;
  policy_version: string;
}

const consentRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseChannelConsentPage(
  value: unknown,
  id: string,
  responseVersion: string | null,
): ChannelConsentPage {
  if (
    !consentRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 5 ||
    !isExactSubscriberVersion(value.subscriber_version, id) ||
    value.subscriber_version !== responseVersion
  ) {
    throw new Error("The consent service returned an invalid response.");
  }
  const seen = new Set<string>();
  const items = value.items.map((candidate) => {
    if (
      !consentRecord(candidate) ||
      typeof candidate.id !== "string" ||
      candidate.subscriber_id !== id ||
      !["email", "sms", "push", "whatsapp", "rcs"].includes(
        String(candidate.channel),
      ) ||
      !["opted_in", "opted_out", "pending", "unknown"].includes(
        String(candidate.status),
      ) ||
      typeof candidate.consent_source !== "string" ||
      typeof candidate.created_at !== "string" ||
      typeof candidate.updated_at !== "string" ||
      !Number.isFinite(Date.parse(candidate.created_at)) ||
      !Number.isFinite(Date.parse(candidate.updated_at)) ||
      (candidate.consent_timestamp != null &&
        (typeof candidate.consent_timestamp !== "string" ||
          !Number.isFinite(Date.parse(candidate.consent_timestamp)))) ||
      (candidate.frequency_cap_until != null &&
        (typeof candidate.frequency_cap_until !== "string" ||
          !Number.isFinite(Date.parse(candidate.frequency_cap_until))))
    ) {
      throw new Error("The consent service returned an invalid response.");
    }
    const channel = candidate.channel as ConsentChannel;
    if (seen.has(channel)) {
      throw new Error("The consent service returned an invalid response.");
    }
    seen.add(channel);
    return candidate as unknown as ChannelConsent;
  });
  return { items, subscriber_version: value.subscriber_version };
}

export function getChannelConsents(
  id: string,
  signal?: AbortSignal,
): Promise<ChannelConsentPage> {
  let responseVersion: string | null = null;
  return api
    .get<unknown>(`${basePath(id)}/channel-consents`, {
      signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    })
    .then((value) => parseChannelConsentPage(value, id, responseVersion));
}

export async function updateChannelConsent(
  id: string,
  channel: ConsentChannel,
  input: ConsentEvidenceInput,
  expectedVersion: string,
  options: { idempotencyKey: string; signal?: AbortSignal },
): Promise<ChannelConsent> {
  if (
    channel !== "email" ||
    !isExactSubscriberVersion(expectedVersion, id) ||
    !options.idempotencyKey ||
    input.evidence.trim() === "" ||
    input.reason.trim() === "" ||
    input.policy_version.trim() === "" ||
    input.jurisdiction.trim() === "" ||
    !Number.isFinite(Date.parse(input.consent_timestamp))
  ) {
    throw new Error("Review the complete consent evidence before saving.");
  }
  let responseVersion: string | null = null;
  const value = await api.patch<ChannelConsent>(
    `${basePath(id)}/channel-consents/${enc(channel)}`,
    {
      ...input,
      evidence: input.evidence.trim(),
      reason: input.reason.trim(),
      policy_version: input.policy_version.trim(),
      jurisdiction: input.jurisdiction.trim().toUpperCase(),
    },
    {
      headers: { "If-Match": expectedVersion },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => {
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  if (
    value.subscriber_id !== id ||
    value.channel !== channel ||
    value.status !== input.status ||
    !isExactSubscriberVersion(value.subscriber_version, id) ||
    value.subscriber_version !== responseVersion
  ) {
    throw new Error("The consent service returned an invalid response.");
  }
  return value;
}

/* ------------------------------- Predictions ------------------------------ */

export interface DemographicTrait {
  value: unknown;
  confidence?: number;
  source?: string;
  computed_at?: string;
}

export interface Demographics {
  subscriber_id: string;
  gender: DemographicTrait | null;
  age_group: DemographicTrait | null;
  interests: DemographicTrait | null;
}

export interface ReplenishmentCadence {
  subscriber_id: string;
  average_days_between_orders: number | null;
  expected_next_order_at: string | null;
  last_order_at: string | null;
  computed_at?: string;
}

export interface BestSendHour {
  best_hour_utc: number;
  computed_at: string;
  sample_size: number;
}

export interface PredictionMetadataItem {
  id: string;
  score_type: string;
  model_version: string;
  confidence?: number;
  features: Record<string, unknown>;
  computed_at: string;
}

export function getDemographics(
  id: string,
  signal?: AbortSignal,
): Promise<Demographics> {
  return api.get(`${basePath(id)}/demographics`, { signal });
}

export function getReplenishmentCadence(
  id: string,
  signal?: AbortSignal,
): Promise<ReplenishmentCadence> {
  return api.get(`${basePath(id)}/replenishment-cadence`, { signal });
}

export function getBestSendTime(
  id: string,
  signal?: AbortSignal,
): Promise<BestSendHour> {
  return api.get(`${basePath(id)}/best-send-time`, { signal });
}

export function getPredictionMetadata(
  id: string,
  signal?: AbortSignal,
): Promise<{ subscriber_id: string; items: PredictionMetadataItem[] }> {
  return api.get(`${basePath(id)}/prediction-metadata`, { signal });
}

/* --------------------------- Audit / attribute history -------------------- */

export interface AuditEntry {
  id: number;
  action: string;
  resource_type?: string;
  actor_type: string;
  actor_label?: string;
  metadata: Record<string, unknown>;
  at: string;
}

export interface AttributeChange {
  id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  source: string;
  changed_by?: string;
  changed_at: string;
}

export function getSubscriberAudit(
  id: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ items: AuditEntry[]; next_cursor?: string }> {
  return api.get(`${basePath(id)}/audit`, { query: { limit }, signal });
}

export function getAttributeHistory(
  id: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ items: AttributeChange[]; next_cursor?: string }> {
  return api.get(`${basePath(id)}/attribute-history`, {
    query: { limit },
    signal,
  });
}

/* --------------------------- Cross-channel timeline ----------------------- */

export interface CrossChannelEvent {
  at: string;
  channel: "email" | "sms";
  type: string;
  label: string;
  campaign_id?: string;
  detail?: Record<string, unknown>;
}

export function getCrossChannelTimeline(
  id: string,
  opts: { before?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<{
  items: CrossChannelEvent[];
  has_more: boolean;
  next_before?: string;
}> {
  return api.get(`${basePath(id)}/cross-channel-timeline`, {
    query: { before: opts.before, limit: opts.limit },
    signal: opts.signal,
  });
}

/* -------------------------------- Receipts -------------------------------- */

/** Consent receipt (Kantara CR v1.1 JSON) as text, for a client-side download. */
export function getConsentReceiptJson(id: string): Promise<string> {
  return fetchTextAuthed(`${basePath(id)}/consent-receipt.json`);
}

export function getErasureReceiptJson(id: string): Promise<string> {
  return fetchTextAuthed(`${basePath(id)}/erasure-receipt`);
}
