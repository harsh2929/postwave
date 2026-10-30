/**
 * evidenceBatch — chunking for the investigation timeline's batch
 * lookup (GET /audit/events?ids=…, ≤100 ids per call). Split out of
 * AuditInvestigationTimeline.tsx so the node-environment vitest suite
 * can import it (the desktop tsconfig keeps `jsx: preserve`, so .tsx
 * modules can't be imported by tests directly).
 */

/** Max ids per getAuditEventsByIds call (server-enforced). */
export const EVIDENCE_BATCH_SIZE = 100;

/** Split a (deduplicated) id list into ≤`size` chunks for the batch
 *  endpoint. */
export function chunkEvidenceIds(
  ids: number[],
  size: number = EVIDENCE_BATCH_SIZE,
): number[][] {
  const unique = [...new Set(ids)];
  const out: number[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    out.push(unique.slice(i, i + size));
  }
  return out;
}
