/**
 * lib/consent-receipts-api.ts — the consent ledger.
 *
 * `/api/v1/consent/receipts` was reached by desktop and by no web file. It is
 * the evidence trail behind every "yes, they opted in" claim.
 *
 * TWO FIELDS HERE ARE LOAD-BEARING AND EASY TO DROP:
 *
 *   source_planes  which underlying stores were consulted
 *                  (`consent_receipts` and `consent_records`). A ledger read
 *                  that silently covered one plane and not the other would be
 *                  incomplete evidence presented as complete.
 *
 *   has_more       whether this is the whole ledger or a page of it. On an
 *                  evidence surface, "12 receipts" and "12 receipts so far"
 *                  are different statements.
 *
 * Both are carried through so the UI can qualify what it is showing.
 *
 * CURSOR PAGING. The server signs a continuation cursor bound to the workspace
 * and to one insert-visibility boundary (`snapshot_at`). An older page is only
 * appended when it still belongs to the same page family: same boundary, same
 * workspace, no repeated cursor, no duplicate row identity, and newest-first
 * ordering preserved across the seam. Anything else is rejected and the rows
 * already loaded are kept — desktop applies the same rules
 * (apps/desktop/src/pages/Consent.tsx:786-804).
 */
import { api } from "@/lib/api";

export interface ConsentReceipt {
  id: string;
  subscriber_email: string;
  /** State before this change, when the source recorded it. */
  prev_state?: string;
  /** e.g. "granted" / "withdrawn". */
  new_state: string;
  source: string;
  source_detail?: string;
  ip?: string;
  user_agent?: string;
  privacy_policy_version?: string;
  captured_text?: string;
  /** When consent was given. */
  at: string;
  /** When we wrote it down — not the same thing. */
  recorded_at: string;
  /** "receipt" = state-change stream, "proof" = structured consent record. */
  kind?: string;
}

export interface ConsentLedger {
  schema_version: number;
  /** Workspace the page family is bound to, when the server reports it. */
  workspace_id?: string;
  snapshot_at?: string;
  /** Which underlying stores this read covered. */
  source_planes: string[];
  receipts: ConsentReceipt[];
  count: number;
  /** True when this is a page rather than the whole ledger. */
  has_more: boolean;
  /** Signed continuation cursor for the next (older) page, when one exists. */
  next_cursor?: string;
}

/** Page size for continuation reads — the server default for page one. */
export const CONSENT_RECEIPT_PAGE_LIMIT = 200;

// Matches the server's signed envelope shape (base64url "." base64url) and
// its 8 KiB bound, so a malformed value never reaches the wire.
const CONSENT_CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const MAX_CONSENT_CURSOR_BYTES = 8192;

export function isConsentCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CONSENT_CURSOR_BYTES &&
    CONSENT_CURSOR.test(value)
  );
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function normalizeLedger(res: ConsentLedger | null | undefined): ConsentLedger {
  const workspaceId =
    typeof res?.workspace_id === "string" && res.workspace_id !== ""
      ? res.workspace_id
      : undefined;
  const rawCursor: unknown = res?.next_cursor;
  const nextCursor = isConsentCursor(rawCursor) ? rawCursor : undefined;
  return {
    schema_version: Number.isFinite(res?.schema_version)
      ? Number(res?.schema_version)
      : 0,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    snapshot_at: res?.snapshot_at,
    source_planes: asArray<string>(res?.source_planes),
    receipts: asArray<ConsentReceipt>(res?.receipts),
    count: Number.isFinite(res?.count) ? Number(res?.count) : 0,
    has_more: res?.has_more === true,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

export async function getConsentLedger(): Promise<ConsentLedger> {
  const res = await api.get<ConsentLedger>("/api/v1/consent/receipts");
  return normalizeLedger(res);
}

/** Thrown before any request when a continuation cursor is not well formed. */
export class ConsentCursorError extends Error {
  constructor() {
    super("The continuation cursor is not valid, so no older page was requested.");
    this.name = "ConsentCursorError";
  }
}

/**
 * The older page after `cursor` — GET /api/v1/consent/receipts?cursor=&limit=.
 * The caller must still run {@link olderReceiptPageFailure} before appending.
 */
export async function getConsentLedgerPage(
  cursor: string,
  options: { signal?: AbortSignal } = {},
): Promise<ConsentLedger> {
  if (!isConsentCursor(cursor)) throw new ConsentCursorError();
  const params = new URLSearchParams({
    cursor,
    limit: String(CONSENT_RECEIPT_PAGE_LIMIT),
  });
  const res = await api.get<ConsentLedger>(
    `/api/v1/consent/receipts?${params.toString()}`,
    { signal: options.signal },
  );
  return normalizeLedger(res);
}

/** Receipts and proofs share an id space only within their own plane. */
export function consentReceiptIdentity(receipt: ConsentReceipt): string {
  return `${receipt.kind || "receipt"}:${receipt.id}`;
}

function fractionRemainder(value: string): number {
  const match = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return 0;
  return Number(match[1]!.padEnd(9, "0").slice(3));
}

/** Negative when `left` sorts before `right` in newest-first order. */
function compareReceiptNewest(
  left: ConsentReceipt,
  right: ConsentReceipt,
): number {
  const ms = Date.parse(right.recorded_at) - Date.parse(left.recorded_at);
  if (Number.isFinite(ms) && ms !== 0) return ms;
  const fraction =
    fractionRemainder(right.recorded_at) - fractionRemainder(left.recorded_at);
  if (fraction !== 0) return fraction;
  const kind = (right.kind ?? "").localeCompare(left.kind ?? "");
  if (kind !== 0) return kind;
  return right.id.localeCompare(left.id);
}

export const INCONSISTENT_RECEIPT_PAGE =
  "The server returned an inconsistent older receipt/proof page. Loaded evidence was kept; refresh from a new boundary before retrying.";

/**
 * Why an older page must NOT be appended to the loaded family, or null when it
 * may be. `loaded` is every row already shown (page one plus earlier appends).
 */
export function olderReceiptPageFailure(
  base: Pick<ConsentLedger, "snapshot_at" | "workspace_id">,
  loaded: readonly ConsentReceipt[],
  page: ConsentLedger,
  requestedCursor: string,
): string | null {
  if (
    page.snapshot_at !== base.snapshot_at ||
    page.workspace_id !== base.workspace_id ||
    (page.receipts.length === 0 && page.has_more) ||
    page.next_cursor === requestedCursor
  ) {
    return INCONSISTENT_RECEIPT_PAGE;
  }
  if (page.receipts.length === 0) return null;
  const identities = new Set(loaded.map(consentReceiptIdentity));
  for (const row of page.receipts) {
    const identity = consentReceiptIdentity(row);
    if (identities.has(identity)) return INCONSISTENT_RECEIPT_PAGE;
    identities.add(identity);
  }
  const seam = [...loaded.slice(-1), ...page.receipts];
  for (let index = 1; index < seam.length; index += 1) {
    if (compareReceiptNewest(seam[index - 1]!, seam[index]!) >= 0) {
      return INCONSISTENT_RECEIPT_PAGE;
    }
  }
  return null;
}
