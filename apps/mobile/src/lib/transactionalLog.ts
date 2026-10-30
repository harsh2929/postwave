/**
 * lib/transactionalLog.ts — the transactional send log, and its triage slice.
 *
 * ASSURE#7: `GET /api/v1/emails` and `/emails/{id}`
 * (transactional/handlers.go:42-43, mounted at main.go:5252-5254 behind
 * ScopeReadReports, manifest `viewer` + reviewed) are rendered by NO client. The
 * platform grew a Resend-parity public send surface and nobody can see what it
 * sent.
 *
 * ── THE SLICE THAT MATTERS ON A PHONE ──────────────────────────────────────
 * The handler documents `?attempt_state=unknown` as "the triage surface for sends
 * whose provider outcome could not be established", and says why it exists:
 * "Without a way to LIST them, 'surfaced for a human rather than guessed at' is a
 * claim about a log line." That is the phone question exactly — not "show me every
 * receipt" but "is anything in an unknown state right now".
 *
 * So the default view is the unknown ones. A full log is a desk artefact; an
 * unresolved outcome is a page.
 *
 * Import-free of react-native, so it is node-tested.
 */

/** Attempt states the handler accepts as a filter (handlers.go:207). */
export const TRANSACTIONAL_ATTEMPT_STATES = [
  "prepared",
  "submitted",
  "acknowledged",
  "rejected",
  "unknown",
] as const;

export type TransactionalAttemptState =
  (typeof TRANSACTIONAL_ATTEMPT_STATES)[number];

export interface TransactionalSend {
  id: string;
  to: string;
  subject: string;
  status: string;
  attemptState: string;
  lastError: string;
  createdAt: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseTransactionalSends(payload: unknown): TransactionalSend[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).emails ??
          (payload as Record<string, unknown>).items)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: TransactionalSend[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    // `to` is an ARRAY on the wire. Joining rather than taking [0] keeps a
    // multi-recipient send from being silently reported as a single one.
    const to = Array.isArray(row.to)
      ? row.to.map((entry) => str(entry)).filter((entry) => entry !== "")
      : [];
    out.push({
      id,
      to: to.join(", "),
      subject: str(row.subject) || "(no subject)",
      status: str(row.status),
      attemptState: str(row.attempt_state),
      lastError: str(row.last_error),
      createdAt: str(row.created_at),
    });
  }
  return out;
}

/**
 * True when the provider outcome was never established.
 *
 * This is NOT the same as failed. A rejected send is a known bad outcome that the
 * suppression machinery already acts on; an unknown one is a send nobody can say
 * landed or didn't, which is the only state a human has to resolve by hand.
 */
export function transactionalOutcomeUnknown(send: TransactionalSend): boolean {
  return send.attemptState.trim().toLowerCase() === "unknown";
}

/** One line for the triage header. */
export function transactionalTriageSummary(
  sends: readonly TransactionalSend[],
): string {
  const unknown = sends.filter(transactionalOutcomeUnknown).length;
  if (unknown === 0) {
    return "Every recent transactional send has a known provider outcome.";
  }
  return `${unknown} send${unknown === 1 ? "" : "s"} with no established provider outcome — nobody can say whether these landed.`;
}
