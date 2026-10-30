// SPDX-License-Identifier: AGPL-3.0-only
//
// send.ts — typed server-side fetch of the ops Send & Delivery views. Same
// fail-loud contract as tenants.ts / board.ts: a non-OK or malformed response
// is a distinct loud failure, never an empty list.
import { fetchOpsViewJSON, viewStatusMessage } from "./opsViewFetch";
import {
  hasDuplicateKey,
  hasOnlyKeys,
  isBoundedText,
  isCanonicalUUID,
  isNonNegativeInteger,
  isRecord,
  isTimestamp,
  MAX_VIEW_ROWS,
  parseTruncatedEnvelope,
} from "./viewSchema";

export interface QueueDepthRow {
  tenant_id: string;
  slug: string;
  name: string;
  pending: number;
  failed: number;
}

export interface DeadLetterRow {
  tenant_id: string;
  slug: string;
  kind: string;
  dead_count: number;
  oldest_dead_at: string;
}

export type QueueDepthResult =
  | { ok: true; rows: QueueDepthRow[]; truncated: boolean }
  | { ok: false; message: string };
export type DeadLettersResult =
  | { ok: true; rows: DeadLetterRow[]; truncated: boolean }
  | { ok: false; message: string };

function fail(status: number): { ok: false; message: string } {
  return { ok: false, message: viewStatusMessage(status, "send view") };
}

export function parseQueueDepth(status: number, body: unknown): QueueDepthResult {
  if (status !== 200) return fail(status);
  const envelope = parseTruncatedEnvelope(body, "tenants");
  if (!envelope) return { ok: false, message: "queue depth returned an unexpected shape" };
  const rows: QueueDepthRow[] = [];
  for (const candidate of envelope.rows) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["tenant_id", "slug", "name", "pending", "failed"]) ||
      !isCanonicalUUID(candidate.tenant_id) ||
      !isBoundedText(candidate.slug, 128) ||
      !isBoundedText(candidate.name, 256) ||
      !isNonNegativeInteger(candidate.pending) ||
      !isNonNegativeInteger(candidate.failed)
    ) return { ok: false, message: "queue depth returned an unexpected shape" };
    rows.push({
      tenant_id: candidate.tenant_id,
      slug: candidate.slug,
      name: candidate.name,
      pending: candidate.pending,
      failed: candidate.failed,
    });
  }
  if (hasDuplicateKey(rows, (row) => row.tenant_id)) {
    return { ok: false, message: "queue depth returned an unexpected shape" };
  }
  return { ok: true, rows, truncated: envelope.truncated };
}

export function parseDeadLetters(status: number, body: unknown): DeadLettersResult {
  if (status !== 200) return fail(status);
  const envelope = parseTruncatedEnvelope(body, "dead_letters");
  if (!envelope) return { ok: false, message: "dead letters returned an unexpected shape" };
  const rows: DeadLetterRow[] = [];
  for (const candidate of envelope.rows) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["tenant_id", "slug", "kind", "dead_count", "oldest_dead_at"]) ||
      !isCanonicalUUID(candidate.tenant_id) ||
      !isBoundedText(candidate.slug, 128) ||
      !isBoundedText(candidate.kind, 256) ||
      !isNonNegativeInteger(candidate.dead_count) ||
      !isTimestamp(candidate.oldest_dead_at)
    ) return { ok: false, message: "dead letters returned an unexpected shape" };
    rows.push({
      tenant_id: candidate.tenant_id,
      slug: candidate.slug,
      kind: candidate.kind,
      dead_count: candidate.dead_count,
      oldest_dead_at: candidate.oldest_dead_at,
    });
  }
  if (hasDuplicateKey(rows, (row) => `${row.tenant_id}\u0000${row.kind}`)) {
    return { ok: false, message: "dead letters returned an unexpected shape" };
  }
  return { ok: true, rows, truncated: envelope.truncated };
}

export async function fetchQueueDepth(): Promise<QueueDepthResult> {
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/views/send/queue-depth?limit=${MAX_VIEW_ROWS}`,
  );
  if (!result.ok) return { ok: false, message: viewStatusMessage(result.status, "queue depth") };
  return parseQueueDepth(result.status, result.body);
}

export async function fetchDeadLetters(): Promise<DeadLettersResult> {
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/views/send/dead-letters?limit=${MAX_VIEW_ROWS}`,
  );
  if (!result.ok) return { ok: false, message: viewStatusMessage(result.status, "dead letters") };
  return parseDeadLetters(result.status, result.body);
}
