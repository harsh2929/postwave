/**
 * consentReceipts — the audited consent ledger for one address, and the wire
 * rules that decide whether it may be shown at all.
 *
 * Split out of `lib/subscriberRecordHistory.ts` (which keeps "what did WE do
 * to this record") because this half answers a different question for a
 * different audience:
 *
 *   GET /api/v1/consent/receipts/by-email/{email}
 *       → { receipts: Receipt[], email, count }
 *       RequireScope(ScopeAdmin) — NOT read-only, so owner|admin ONLY on a
 *       session. That is the difference that matters: the two cards on the
 *       same screen have different audiences, and gating them together would
 *       either hide history from viewers who may see it or show an
 *       inevitable 403 to everyone else.
 *
 * The whole surface is re-exported from `lib/subscriberRecordHistory.ts`, so
 * that stays the import site callers use.
 *
 * Import-free of react-native, so all of it is unit-tested.
 */
import { transitionLabel } from "./direction";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface ConsentReceipt {
  id: string;
  prevState: string;
  newState: string;
  source: string;
  sourceDetail: string;
  ip: string;
  userAgent: string;
  policyVersion: string;
  capturedText: string;
  at: string | null;
  recordedAt: string;
  /** "receipt" = state-change stream, "proof" = structured capture. */
  kind: "receipt" | "proof";
}

export interface ConsentReceiptPage {
  receipts: ConsentReceipt[];
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  snapshotAt: string;
}

const CONSENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONSENT_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
// Server-authenticated consent cursor: opaque base64url payload + HMAC.
const CONSENT_CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const CONSENT_UNSAFE_TOKEN =
  /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F\uFEFF]/u;
const CONSENT_UNSAFE_NARRATIVE =
  /[\u0000\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F\uFEFF]/u;
const CONSENT_RECEIPT_KEYS = new Set([
  "id",
  "subscriber_email",
  "prev_state",
  "new_state",
  "source",
  "source_detail",
  "ip",
  "user_agent",
  "privacy_policy_version",
  "captured_text",
  "at",
  "recorded_at",
  "kind",
]);
const CONSENT_PAGE_KEYS = new Set([
  "schema_version",
  "workspace_id",
  "snapshot_at",
  "source_planes",
  "receipts",
  "email",
  "count",
  "has_more",
  "next_cursor",
]);
const RECEIPT_STATES = new Set([
  "subscribed",
  "unsubscribed",
  "bounced",
  "complained",
  "pending",
]);
const PROOF_STATES = new Set(["granted", "withdrawn", "pending", "expired"]);

function consentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function consentExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function consentToken(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length > 0 &&
    Array.from(value).length <= max &&
    new TextEncoder().encode(value).byteLength <= max &&
    value === value.trim() &&
    !CONSENT_UNSAFE_TOKEN.test(value)
  );
}

function consentNarrative(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= max &&
    new TextEncoder().encode(value).byteLength <= max &&
    !CONSENT_UNSAFE_NARRATIVE.test(value)
  );
}

function consentEmail(value: unknown): value is string {
  if (!consentToken(value, 320)) return false;
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
}

function consentTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CONSENT_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function consentFraction(value: string): number {
  const match = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  return match ? Number(match[1]!.padEnd(9, "0").slice(3)) : 0;
}

function compareConsentTime(a: string, b: string): number {
  return (
    Date.parse(a) - Date.parse(b) || consentFraction(a) - consentFraction(b)
  );
}

function optionalConsentToken(value: unknown, max: number): boolean {
  return value === undefined || consentToken(value, max);
}

function optionalConsentNarrative(value: unknown, max: number): boolean {
  return value === undefined || consentNarrative(value, max);
}

function validConsentReceipt(value: unknown): value is Record<string, unknown> {
  if (!consentRecord(value) || !consentExactKeys(value, CONSENT_RECEIPT_KEYS)) {
    return false;
  }
  if (value.kind !== "receipt" && value.kind !== "proof") return false;
  const validId =
    value.kind === "receipt"
      ? typeof value.id === "string" && /^[1-9]\d{0,19}$/u.test(value.id)
      : typeof value.id === "string" && CONSENT_UUID.test(value.id);
  const validState =
    typeof value.new_state === "string" &&
    (value.kind === "receipt"
      ? RECEIPT_STATES.has(value.new_state)
      : PROOF_STATES.has(value.new_state));
  return (
    validId &&
    consentEmail(value.subscriber_email) &&
    validState &&
    optionalConsentToken(value.prev_state, 128) &&
    consentToken(value.source, 512) &&
    optionalConsentNarrative(value.source_detail, 16_384) &&
    optionalConsentToken(value.ip, 64) &&
    optionalConsentToken(value.user_agent, 2_048) &&
    optionalConsentToken(value.privacy_policy_version, 256) &&
    optionalConsentNarrative(value.captured_text, 65_536) &&
    consentTime(value.at) &&
    consentTime(value.recorded_at)
  );
}

function invalidConsentEvidence(): never {
  throw new Error("The consent evidence response could not be verified.");
}

/**
 * The page envelope once `isConsentPageWire` has vouched for it. Only the
 * fields read afterwards are narrowed; `count` and `next_cursor` stay
 * `unknown` because the original code casts them at the point of use.
 */
type ConsentPageWire = {
  workspace_id: string;
  snapshot_at: string;
  email: string;
  receipts: Record<string, unknown>[];
  count: unknown;
  has_more: boolean;
  next_cursor: unknown;
};

/**
 * Provenance: this is the expected workspace's ledger, stamped with the time
 * it was taken, assembled from BOTH consent planes. A page that names one
 * plane is a page that silently dropped half the ledger, and half a consent
 * ledger shown as a whole one is the compliance-relevant lie.
 */
function hasConsentPageProvenance(
  raw: Record<string, unknown>,
  expectedWorkspaceId: string,
): boolean {
  return (
    consentExactKeys(raw, CONSENT_PAGE_KEYS) &&
    raw.schema_version === 1 &&
    consentToken(raw.workspace_id, 64) &&
    CONSENT_UUID.test(raw.workspace_id) &&
    CONSENT_UUID.test(expectedWorkspaceId.trim()) &&
    raw.workspace_id.toLowerCase() ===
      expectedWorkspaceId.trim().toLowerCase() &&
    consentTime(raw.snapshot_at) &&
    Array.isArray(raw.source_planes) &&
    raw.source_planes.length === 2 &&
    raw.source_planes[0] === "consent_receipts" &&
    raw.source_planes[1] === "consent_records"
  );
}

/**
 * The body: the address that was asked about, the rows themselves, and a
 * cursor that exists exactly when the server says there is more. A `has_more`
 * page carrying no cursor is a page whose next fetch would silently restart.
 */
function hasConsentPageBody(
  raw: Record<string, unknown>,
  expectedEmail: string,
): boolean {
  return (
    consentEmail(raw.email) &&
    raw.email.toLowerCase() === expectedEmail.trim().toLowerCase() &&
    Array.isArray(raw.receipts) &&
    raw.receipts.length <= 1_000 &&
    raw.receipts.every(validConsentReceipt) &&
    Number.isSafeInteger(raw.count) &&
    raw.count === raw.receipts.length &&
    typeof raw.has_more === "boolean" &&
    (raw.has_more
      ? consentToken(raw.next_cursor, 8_192) &&
        CONSENT_CURSOR.test(raw.next_cursor)
      : raw.next_cursor === undefined)
  );
}

function isConsentPageWire(
  raw: unknown,
  expectedWorkspaceId: string,
  expectedEmail: string,
): raw is ConsentPageWire {
  return (
    consentRecord(raw) &&
    hasConsentPageProvenance(raw, expectedWorkspaceId) &&
    hasConsentPageBody(raw, expectedEmail)
  );
}

/**
 * Every row belongs to this address, none is stamped after the snapshot it
 * came from, none repeats, and the page runs newest-first in exactly the
 * (recorded_at, kind, id) order the cursor pages by. A page that is not is a
 * page whose next fetch would skip or repeat rows.
 */
function consentReceiptsWellOrdered(
  receipts: Record<string, unknown>[],
  snapshotAt: string,
  expectedEmail: string,
): boolean {
  const seen = new Set<string>();
  for (let index = 0; index < receipts.length; index += 1) {
    const row = receipts[index]!;
    if (
      String(row.subscriber_email).toLowerCase() !==
        expectedEmail.trim().toLowerCase() ||
      compareConsentTime(String(row.recorded_at), snapshotAt) > 0
    ) {
      return false;
    }
    const identity = `${String(row.kind)}:${String(row.id)}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    if (index === 0) continue;
    const previous = receipts[index - 1]!;
    const chronology = compareConsentTime(
      String(previous.recorded_at),
      String(row.recorded_at),
    );
    if (
      chronology < 0 ||
      (chronology === 0 && String(previous.kind) < String(row.kind)) ||
      (chronology === 0 &&
        previous.kind === row.kind &&
        String(previous.id) <= String(row.id))
    ) {
      return false;
    }
  }
  return true;
}

export function parseConsentReceipts(
  raw: unknown,
  expectedWorkspaceId: string,
  expectedEmail: string,
): ConsentReceiptPage {
  if (!isConsentPageWire(raw, expectedWorkspaceId, expectedEmail)) {
    return invalidConsentEvidence();
  }
  if (
    !consentReceiptsWellOrdered(raw.receipts, raw.snapshot_at, expectedEmail)
  ) {
    return invalidConsentEvidence();
  }

  return {
    receipts: raw.receipts.map((row) => ({
      id: String(row.id),
      prevState: str(row.prev_state),
      newState: String(row.new_state),
      source: String(row.source),
      sourceDetail: str(row.source_detail),
      ip: str(row.ip),
      userAgent: str(row.user_agent),
      policyVersion: str(row.privacy_policy_version),
      capturedText: str(row.captured_text),
      at: String(row.at),
      recordedAt: String(row.recorded_at),
      kind: row.kind as "receipt" | "proof",
    })),
    count: raw.count as number,
    hasMore: raw.has_more,
    nextCursor: raw.has_more ? String(raw.next_cursor) : null,
    snapshotAt: raw.snapshot_at,
  };
}

/** "Opted in via signup form" rather than "enabled ← (blank) / form". */
export function receiptHeadline(receipt: ConsentReceipt): string {
  const to = receipt.newState.trim() || "unknown";
  const from = receipt.prevState.trim();
  return from ? transitionLabel(from, to) : to;
}

/**
 * The evidence line. `kind` matters: a "proof" row is the structured capture
 * an auditor asks for, a "receipt" row is the state-change stream. Saying
 * which is the difference between showing a receipt and showing a log entry.
 */
export function receiptEvidence(receipt: ConsentReceipt): string {
  const parts = [
    receipt.kind === "proof" ? "Proof of capture" : "State change",
    receipt.source.trim(),
    receipt.sourceDetail.trim(),
    receipt.policyVersion.trim()
      ? `Policy ${receipt.policyVersion.trim()}`
      : "",
    receipt.ip.trim() ? `IP ${receipt.ip.trim()}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * What to say when the lookup returns nothing.
 *
 * "No receipts" and "this person never consented" are different claims. The
 * ledger only holds records the platform captured; an address imported before
 * the ledger existed has none, and reporting that as an absence of consent
 * would be a compliance-relevant lie.
 */
export const NO_RECEIPTS_MESSAGE =
  "No consent records were captured for this address. That is not proof they never opted in — records only exist for consent this platform captured itself.";
