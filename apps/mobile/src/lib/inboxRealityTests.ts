/**
 * lib/inboxRealityTests.ts — on-demand seed-list placement tests.
 *
 * VERB#12: `GET /api/v1/inbox-reality/tests` and
 * `POST /api/v1/inbox-reality/tests/{id}/cancel` are mounted
 * (inboxreality/handlers.go:88-92, viewer read / editor cancel, both reviewed) and
 * mobile had only the pre-send PREDICTOR (api/inboxReality.ts). So a placement test
 * already running — which consumes seed-mailbox capacity and provider budget —
 * could be neither watched nor stopped from a phone.
 *
 * The statuses come from types.go:123-137: awaiting_delivery, classifying,
 * complete, expired, cancelled. Only the first two are live; the last three are
 * terminal, and cancelling one is a control with nothing to cancel.
 *
 * Import-free of react-native, so it is node-tested.
 */

export const INBOX_REALITY_TERMINAL_STATUSES = [
  "complete",
  "expired",
  "cancelled",
] as const;

export interface InboxRealityTest {
  id: string;
  subject: string;
  status: string;
  kind: string;
  createdAt: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseInboxRealityTests(payload: unknown): InboxRealityTest[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).items ??
          (payload as Record<string, unknown>).tests)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: InboxRealityTest[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    out.push({
      id,
      subject: str(row.subject) || "(no subject)",
      status: str(row.status),
      kind: str(row.kind),
      // The payload is camelCase here, unlike most of this API.
      createdAt: str(row.createdAt) || str(row.created_at),
    });
  }
  return out;
}

/** True while the test still holds seed capacity. */
export function inboxRealityTestIsLive(status: string): boolean {
  return !(INBOX_REALITY_TERMINAL_STATUSES as readonly string[]).includes(
    status.trim().toLowerCase(),
  );
}

/**
 * What the test is doing, in terms of the resource it is holding.
 *
 * `awaiting_delivery` is the state worth naming precisely: the mail has gone to
 * the seed mailboxes and the platform is waiting for it to arrive, so cancelling
 * frees the capacity but does not un-send anything.
 */
export function inboxRealityTestSummary(test: InboxRealityTest): string {
  switch (test.status.trim().toLowerCase()) {
    case "awaiting_delivery":
      return "Sent to the seed mailboxes; waiting for arrival. Cancelling frees the seats but cannot un-send it.";
    case "classifying":
      return "Delivered — classifying where it landed.";
    case "complete":
      return "Finished.";
    case "expired":
      return "Expired before every seed mailbox reported.";
    case "cancelled":
      return "Cancelled.";
    default:
      return test.status || "Status unknown.";
  }
}
