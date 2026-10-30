/**
 * subscriberValidateEmails — "are these addresses any good?", for a thumb-
 * assembled selection.
 *
 * Desktop's bulk Validate emails verb (useBulkUtilityActions) calls the
 * surface validator — POST /api/v1/email-validation/check-batch (admin):
 * syntax, MX, disposable-domain and role-account checks, NO provider credits
 * spent. (The parity register names /verification/verify-batch, but that is
 * the billable 8-address synchronous provider path; the desktop anchor this
 * row mirrors has never called it.)
 *
 * HONEST-UI, same as desktop's ValidationResultsModal: validation is
 * surface-only — a "Deliverable" verdict means the address LOOKS deliverable,
 * and the receipt never claims more. Verdict labels mirror desktop's
 * verdictLabel verbatim; unknown verdicts pass through so a new server
 * verdict is never mislabeled.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface ValidationRow {
  email: string;
  valid: boolean;
  /** 'ok' | 'syntax_invalid' | 'no_mx' | 'disposable' | 'role_account' | … */
  verdict: string;
}

export interface ValidationBatchView {
  rows: ValidationRow[];
  total: number;
  valid: number;
  invalid: number;
  /** verdict → count for the INVALID rows, first-appearance ordered. */
  byVerdict: [verdict: string, count: number][];
}

/** Desktop's verdictLabel, verbatim. */
export function verdictLabel(verdict: string): string {
  switch (verdict) {
    case "ok":
      return "Deliverable";
    case "syntax_invalid":
      return "Invalid syntax";
    case "no_mx":
      return "No mail server (MX)";
    case "disposable":
      return "Disposable domain";
    case "role_account":
      return "Role account";
    default:
      return verdict;
  }
}

/**
 * The EmailValidationBatchResponse, defensively. The server's own summary is
 * preferred when present (desktop does the same); the verdict breakdown is
 * computed here because the server does not provide one.
 */
export function parseValidationBatch(payload: unknown): ValidationBatchView {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const rows: ValidationRow[] = Array.isArray(rec.results)
    ? rec.results.flatMap((row): ValidationRow[] => {
        if (!row || typeof row !== "object") return [];
        const r = row as Record<string, unknown>;
        const email = typeof r.email === "string" ? r.email : "";
        if (!email) return [];
        return [
          {
            email,
            valid: r.valid === true,
            verdict: typeof r.verdict === "string" ? r.verdict : "",
          },
        ];
      })
    : [];
  const summary =
    rec.summary && typeof rec.summary === "object"
      ? (rec.summary as Record<string, unknown>)
      : {};
  const n = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const byVerdict = new Map<string, number>();
  for (const row of rows) {
    if (row.valid) continue;
    byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
  }
  return {
    rows,
    total: n(summary.total, rows.length),
    valid: n(summary.valid, rows.filter((r) => r.valid).length),
    invalid: n(summary.invalid, rows.filter((r) => !r.valid).length),
    byVerdict: [...byVerdict.entries()],
  };
}

/** The rows worth listing: the problems, in response order. */
export function invalidValidationRows(
  view: ValidationBatchView,
): ValidationRow[] {
  return view.rows.filter((row) => !row.valid);
}

/**
 * One sentence for the sheet header. `skipped` = selected rows that carried
 * no address — named, never folded into the checked count.
 */
export function validationReceipt(
  view: ValidationBatchView,
  skipped: number,
): string {
  const base = `${view.valid} of ${view.total} look deliverable`;
  const bad = view.invalid > 0 ? `, ${view.invalid} flagged` : "";
  const skip = skipped > 0 ? ` · ${skipped} selected without an address` : "";
  return `${base}${bad}.${skip}`;
}
