/**
 * lib/outboxDlq.ts — the transactional outbox dead-letter queue.
 *
 * VERB#10: `GET /api/v1/dlq` and `POST /api/v1/dlq/{id}/replay` are mounted
 * (server/tenant_governance.go:81-82, both admin + reviewed) and had no client.
 * Mobile ships the AUDIT-SINK DLQ — a different queue with its own routes — so the
 * gap read as covered when the more consequential one was not.
 *
 * This is the queue that carries side effects: the work a request promised and
 * handed off. An entry stuck here is a webhook that never fired or a downstream
 * write that never happened, and nothing surfaces it — the original request
 * returned 200. A silent DLQ is the definition of a system that looks healthy and
 * is not.
 *
 * Import-free of react-native, so it is node-tested.
 */

export interface OutboxDlqEntry {
  id: string;
  topic: string;
  attempts: number;
  lastError: string;
  failedAt: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseOutboxDlq(payload: unknown): OutboxDlqEntry[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).items ??
          (payload as Record<string, unknown>).entries)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: OutboxDlqEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    // Without an id the entry cannot be replayed, and a row you can only look at
    // is worse than absent on a screen whose whole purpose is the verb.
    if (!id) continue;
    const attempts = Number(row.attempts ?? row.attempt_count);
    out.push({
      id,
      topic: str(row.topic) || str(row.event_type) || "unknown",
      attempts: Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 0,
      lastError: str(row.last_error) || str(row.error),
      failedAt: str(row.failed_at) || str(row.created_at),
    });
  }
  return out;
}

/**
 * What the queue's depth means, said without false comfort.
 *
 * Zero is stated as a fact about the QUEUE rather than about the system: the DLQ
 * being empty does not prove side effects are landing, only that none has
 * exhausted its retries.
 */
export function outboxDlqSummary(entries: readonly OutboxDlqEntry[]): string {
  if (entries.length === 0) {
    return "Nothing has exhausted its retries. That is not the same as everything having landed.";
  }
  const worst = entries.reduce(
    (max, entry) => Math.max(max, entry.attempts),
    0,
  );
  return `${entries.length} side effect${entries.length === 1 ? "" : "s"} gave up after retrying — up to ${worst} attempt${worst === 1 ? "" : "s"}. Each one is work a request already reported as done.`;
}
