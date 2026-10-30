/**
 * auth-matrix-helpers — pure logic behind the AuthChecksMatrixCard
 * (#43, proxied GET /api/v1/auth-checks).
 *
 * The wire shape is a BARE ARRAY of per-domain rows, each carrying
 * five AuthCheckRecord cells (spf/dkim/dmarc/bimi/ptr) with
 * status ∈ {ok, warn, fail} + a free-text detail string.
 */

import type { AuthCheckMatrixRow, AuthCheckRecord } from "../../lib/api-client";

/** Column order for the matrix — matches the wire field order. */
export const AUTH_CHECK_KEYS = ["spf", "dkim", "dmarc", "bimi", "ptr"] as const;

export type AuthCheckKey = (typeof AUTH_CHECK_KEYS)[number];

export const AUTH_CHECK_LABELS: Readonly<Record<AuthCheckKey, string>> = {
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
  bimi: "BIMI",
  ptr: "PTR",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= 8_192 &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isAuthCheckRecord(value: unknown): value is AuthCheckRecord {
  return (
    isRecord(value) &&
    isBoundedText(value.status) &&
    isBoundedText(value.detail, true)
  );
}

/** Reject a successful-but-malformed bare-array response before rendering. */
export function parseAuthCheckMatrix(
  value: unknown,
): AuthCheckMatrixRow[] | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  for (const row of value) {
    if (!isRecord(row) || !isBoundedText(row.domain)) return null;
    if (!AUTH_CHECK_KEYS.every((key) => isAuthCheckRecord(row[key]))) {
      return null;
    }
  }
  return value as AuthCheckMatrixRow[];
}

/** Badge class per check status. Unknown statuses render neutral —
 *  never paint an unrecognized value green. */
export function authStatusBadgeClass(status: string): string {
  switch (status) {
    case "ok":
      return "badge success";
    case "warn":
      return "badge warning";
    case "fail":
      return "badge danger";
    default:
      return "badge";
  }
}

export function authStatusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "Pass";
    case "warn":
      return "Warn";
    case "fail":
      return "Fail";
    default:
      return status || "—";
  }
}

/** Typed cell accessor so the matrix render can iterate AUTH_CHECK_KEYS. */
export function authCheckCell(
  row: AuthCheckMatrixRow,
  key: AuthCheckKey,
): AuthCheckRecord {
  return row[key];
}

/**
 * Worst status across a domain's five checks — drives the per-domain
 * rollup badge. fail > warn > unknown > ok (an unrecognized status is
 * treated as more alarming than ok: we can't vouch for it).
 */
export function domainWorstStatus(
  row: AuthCheckMatrixRow,
): "ok" | "warn" | "fail" | "unknown" {
  let sawWarn = false;
  let sawUnknown = false;
  for (const key of AUTH_CHECK_KEYS) {
    const s = authCheckCell(row, key)?.status;
    if (s === "fail") return "fail";
    if (s === "warn") sawWarn = true;
    else if (s !== "ok") sawUnknown = true;
  }
  if (sawWarn) return "warn";
  if (sawUnknown) return "unknown";
  return "ok";
}
