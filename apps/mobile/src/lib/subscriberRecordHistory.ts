/**
 * subscriberRecordHistory — who changed what on a subscriber, and the
 * consent receipts behind their opt-in.
 *
 * The profile's timeline answers "what did this person DO" (opens, clicks,
 * sends). Neither client could answer "what did WE do to this record" or
 * "prove they opted in", which are the two questions a support agent gets
 * while the person is still on the phone. Both endpoints exist:
 *
 *   GET /api/v1/subscribers/{id}/attribute-history?limit=&before=
 *       → { items: AttributeHistoryEvent[], next_cursor? }
 *       RequireScope(ScopeReadSubscribers) — a READ-ONLY scope, so every
 *       authenticated role may see it.
 *
 *   GET /api/v1/consent/receipts/by-email/{email}
 *       → { receipts: Receipt[], email, count }
 *       RequireScope(ScopeAdmin) — NOT read-only, so owner|admin ONLY on a
 *       session. This is the difference that matters: the two cards on the
 *       same screen have different audiences, and gating them together would
 *       either hide history from viewers who may see it or show an
 *       inevitable 403 to everyone else.
 *
 * Every field name the history reports is a raw column (`first_name`,
 * `mailchimp_status`, `custom_fields.plan`), and rendering those to an
 * operator is how a UI teaches people the schema instead of the product —
 * `attributeFieldLabel` is the translation, and it falls back to the raw
 * name rather than inventing one.
 *
 * Import-free so all of it is unit-tested.
 */

/**
 * The consent half lives in `lib/consentReceipts.ts` — a different endpoint
 * with a different scope, as the comment above spells out — and is
 * re-exported here unchanged, so `@/lib/subscriberRecordHistory` stays the
 * one import site the screen and its hook already use.
 */
export {
  NO_RECEIPTS_MESSAGE,
  parseConsentReceipts,
  receiptEvidence,
  receiptHeadline,
} from "./consentReceipts";
export type { ConsentReceipt, ConsentReceiptPage } from "./consentReceipts";

const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  mailchimp_status: "Mailchimp status",
  consent_source: "Consent source",
  locale: "Locale",
  language: "Language",
  country: "Country",
  region: "Region",
  email: "Email address",
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  display_name: "Display name",
  signup_ip: "Signup IP",
};

/**
 * The PII subset the server itself flags (piiAttributeFields in
 * apps/api/internal/subscribers/attribute_history.go). Marking these in the
 * UI is the point of the audit trail: a status flip and an email rewrite are
 * not the same event.
 */
const PII_FIELDS = new Set([
  "email",
  "first_name",
  "last_name",
  "full_name",
  "display_name",
  "signup_ip",
  "consent_source",
]);

export function attributeFieldLabel(field: string | undefined): string {
  const raw = (field ?? "").trim();
  if (!raw) return "Unknown field";
  const direct = FIELD_LABELS[raw];
  if (direct) return direct;
  // The jsonb maps are diffed per key: "custom_fields.plan".
  const dot = raw.indexOf(".");
  if (dot > 0) {
    const bucket = raw.slice(0, dot);
    const key = raw.slice(dot + 1);
    if (bucket === "custom_fields") return `Custom field · ${key}`;
    if (bucket === "merge_fields") return `Merge field · ${key}`;
  }
  return raw;
}

export function isPiiField(field: string | undefined): boolean {
  const raw = (field ?? "").trim();
  if (PII_FIELDS.has(raw)) return true;
  return raw.startsWith("custom_fields.") || raw.startsWith("merge_fields.");
}

export interface RecordHistoryEvent {
  id: string;
  field: string;
  /** null means the field was ABSENT before, not that it was empty. */
  oldValue: string | null;
  newValue: string | null;
  source: string;
  changedBy: string;
  changedAt: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseRecordHistory(raw: unknown): {
  events: RecordHistoryEvent[];
  nextCursor: string | null;
} {
  const envelope = raw as
    | { items?: unknown; next_cursor?: unknown }
    | undefined;
  const items = Array.isArray(envelope?.items) ? envelope.items : [];
  const events: RecordHistoryEvent[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const field = str(row.field_name);
    if (!field) continue;
    events.push({
      id: str(row.id) || `${field}-${str(row.changed_at)}`,
      field,
      oldValue: nullableStr(row.old_value),
      newValue: nullableStr(row.new_value),
      source: str(row.source),
      changedBy: str(row.changed_by),
      changedAt: str(row.changed_at) || null,
    });
  }
  const cursor = str(envelope?.next_cursor);
  return { events, nextCursor: cursor || null };
}

/**
 * "Added", "Cleared", or "Changed" — which of the three a row is depends on
 * NULL vs empty string, and collapsing them would misreport a field that was
 * never set as one that was blanked.
 */
export function changeVerb(event: RecordHistoryEvent): string {
  if (event.oldValue === null && event.newValue !== null) return "Set";
  if (event.oldValue !== null && event.newValue === null) return "Cleared";
  return "Changed";
}

/** Render a value for display. An absent value is an em-dash, never "". */
export function displayValue(value: string | null): string {
  if (value === null) return "—";
  return value.trim() === "" ? "(empty)" : value;
}

/** Who did it. The server leaves `changed_by` empty for system writes. */
export function changedByLabel(event: RecordHistoryEvent): string {
  const who = event.changedBy.trim();
  const source = event.source.trim();
  if (who && source) return `${who} · ${source}`;
  if (who) return who;
  if (source) return source;
  return "System";
}
