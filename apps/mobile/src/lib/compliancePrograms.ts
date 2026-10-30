/**
 * lib/compliancePrograms.ts — the wire shapes of the compliance tracker, and
 * the normalizers that turn them into something a screen may state as fact.
 *
 * READ OFF THE GO STRUCTS, NOT OFF THE OPENAPI SUMMARY. `Program`
 * (apps/api/internal/compliance/compliance.go:72-83) and `Event`
 * (compliance.go:86-97) both carry explicit camelCase json tags, so the wire is
 * camelCase — `signedByEmail`, `documentSha256`, `attestedAt`, `renewalAt`.
 * The collection responses are enveloped: `{"programs": [...]}`
 * (compliance.go:172) and `{"events": [...]}` (compliance.go:488).
 *
 * THREE ABSENCES THAT ARE NOT ZEROES, AND ONE STATUS THAT DOES NOT MEAN WHAT
 * IT SAYS:
 *
 *  1. `attestedAt` / `renewalAt` / `updatedAt` are `*time.Time` with
 *     `omitempty`, so a program that has never been attested simply has no
 *     such keys. They normalize to "" — never to an epoch date, which would
 *     render as "Jan 1, 1970" and read as a real event.
 *
 *  2. `documentSha256` is `NOT NULL DEFAULT ''` (migration 0193 line 30) with
 *     `omitempty` on the tag. An attested program with no hash is an
 *     attestation with NO EVIDENCE ATTACHED, which is a materially different
 *     thing from one with a hash — so the empty string is preserved and the UI
 *     says so, rather than hiding the field.
 *
 *  3. `status: "in_progress"` DOES NOT MEAN "somebody is working on it".
 *     `compliance.go` is the only writer of `compliance_programs` in the
 *     codebase, its single INSERT hard-codes `status = 'attested'`
 *     (compliance.go:245) and `RevokeProgram` only ever UPDATEs an existing
 *     row to 'revoked'. So no row is ever stored as 'in_progress'; the value
 *     is SYNTHESIZED by `ListPrograms` for a framework with no row at all
 *     (compliance.go:168). The honest rendering is "no attestation on file",
 *     not "in progress" — the latter claims a state of work that nothing in
 *     the system recorded.
 *
 * A KNOWN SERVER-SIDE AMBIGUITY THIS FILE CANNOT REPAIR. `ListPrograms`
 * swallows its own query error (`if err == nil {` at compliance.go:143) and
 * still answers 200, so a failed database read is indistinguishable on the
 * wire from a workspace that has attested to nothing: every framework comes
 * back synthesized as 'in_progress'. The copy on the screen is therefore
 * phrased as a statement about the RECORD ("no attestation record came back")
 * and never as a statement about the workspace's behaviour.
 *
 * DELIBERATELY IMPORT-FREE apart from the catalogue's tiebreak helper.
 */
import { frameworkCatalogueIndex } from "@/lib/complianceFrameworks";

/**
 * `LIMIT 500` on the event ledger (compliance.go:467). Carried here so the
 * ledger can disclose that a full page may be a truncation rather than the
 * whole history.
 */
export const COMPLIANCE_EVENTS_LIMIT = 500;

/** Statuses the CHECK constraint permits, plus the two the API synthesizes. */
export type ComplianceStatus =
  | "attested"
  | "in_progress"
  | "revoked"
  | "unsupported"
  | "unknown";

/** `event_type` CHECK values (migration 0193 lines 53-54). */
export type ComplianceEventType =
  | "attested"
  | "renewed"
  | "revoked"
  | "amended"
  | "unknown";

export interface ComplianceProgram {
  framework: string;
  status: ComplianceStatus;
  /** Exactly what the server sent, for the "unknown status" disclosure. */
  rawStatus: string;
  signedByEmail: string;
  signerName: string;
  documentPath: string;
  documentSha256: string;
  notes: string;
  /** ISO strings, or "" when the key was absent. Never an epoch date. */
  attestedAt: string;
  renewalAt: string;
  updatedAt: string;
}

export interface ComplianceEvent {
  id: string;
  framework: string;
  eventType: ComplianceEventType;
  rawEventType: string;
  signedByEmail: string;
  counterSignedBy: string;
  documentPath: string;
  documentSha256: string;
  notes: string;
  at: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Pull `key` out of an envelope, tolerating a bare array body. */
function envelope(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  const held = record(raw)[key];
  return Array.isArray(held) ? held : [];
}

const STATUSES: readonly ComplianceStatus[] = [
  "attested",
  "in_progress",
  "revoked",
  "unsupported",
];

function normalizeStatus(raw: string): ComplianceStatus {
  const lowered = raw.toLowerCase();
  return (STATUSES as readonly string[]).includes(lowered)
    ? (lowered as ComplianceStatus)
    : "unknown";
}

const EVENT_TYPES: readonly ComplianceEventType[] = [
  "attested",
  "renewed",
  "revoked",
  "amended",
];

function normalizeEventType(raw: string): ComplianceEventType {
  const lowered = raw.toLowerCase();
  return (EVENT_TYPES as readonly string[]).includes(lowered)
    ? (lowered as ComplianceEventType)
    : "unknown";
}

export function normalizeComplianceProgram(raw: unknown): ComplianceProgram {
  const row = record(raw);
  const rawStatus = str(row.status);
  return {
    framework: str(row.framework),
    status: normalizeStatus(rawStatus),
    rawStatus,
    signedByEmail: str(row.signedByEmail),
    signerName: str(row.signerName),
    documentPath: str(row.documentPath),
    documentSha256: str(row.documentSha256),
    notes: str(row.notes),
    attestedAt: str(row.attestedAt),
    renewalAt: str(row.renewalAt),
    updatedAt: str(row.updatedAt),
  };
}

/**
 * Rows with no framework slug are DROPPED, not rendered as a blank card.
 * The slug is half of the primary key (migration 0193 line 37); a row without
 * one cannot be looked up, cannot be described, and cannot be acted on.
 */
export function normalizeCompliancePrograms(raw: unknown): ComplianceProgram[] {
  return envelope(raw, "programs")
    .map(normalizeComplianceProgram)
    .filter((program) => program.framework !== "");
}

export function normalizeComplianceEvent(
  raw: unknown,
  framework: string,
): ComplianceEvent {
  const row = record(raw);
  const rawEventType = str(row.eventType);
  return {
    id: str(row.id),
    framework: str(row.framework) || framework,
    eventType: normalizeEventType(rawEventType),
    rawEventType,
    signedByEmail: str(row.signedByEmail),
    counterSignedBy: str(row.counterSignedBy),
    documentPath: str(row.documentPath),
    documentSha256: str(row.documentSha256),
    notes: str(row.notes),
    at: str(row.at),
  };
}

/**
 * The ledger, newest first — which is the order the server already returns
 * (`ORDER BY at DESC`, compliance.go:467). Not re-sorted here: re-sorting on a
 * client-parsed timestamp would silently reorder rows whose `at` failed to
 * parse, and the server's order is authoritative.
 */
export function normalizeComplianceEvents(
  raw: unknown,
  framework: string,
): ComplianceEvent[] {
  return envelope(raw, "events").map((row) =>
    normalizeComplianceEvent(row, framework),
  );
}

/** True when the ledger came back full and may therefore be truncated. */
export function ledgerMayBeTruncated(count: number): boolean {
  return count >= COMPLIANCE_EVENTS_LIMIT;
}

/**
 * Stable tiebreak used behind the urgency sort. Exported so the sort in
 * `compliancePosture` does not have to import the catalogue twice.
 */
export function programCatalogueIndex(program: ComplianceProgram): number {
  return frameworkCatalogueIndex(program.framework);
}
