/**
 * hooks/useMigrationEvidence.ts — the field-level evidence query.
 *
 * PRESS-DRIVEN BY CONSTRUCTION. `enabled` is the caller's disclosure state, so
 * opening a migration's report costs one request and opening its EVIDENCE
 * costs a second one only if somebody asks. TanStack never starts a disabled
 * query on mount, focus or reconnect, so a sheet that opens and closes without
 * the section being expanded never touches the route.
 *
 * A LONG WINDOW IS HONEST HERE. A verification report is written once when the
 * import finishes and is never edited afterwards, so a cached copy is not a
 * stale copy. The one case that moves — a job that had no report a minute ago
 * and has one now — resolves to `null`, and a null is what the caller re-asks
 * for on its next open rather than something this hook keeps forever.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchMigrationVerificationEvidence } from "@/api/migrationEvidence";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { MigrationEvidence } from "@/lib/migrationEvidence";

const EVIDENCE_STALE_MS = 300_000;

export function useMigrationVerificationEvidence(
  jobId: string | null,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<MigrationEvidence | null>({
    queryKey: ["migration-evidence", gate.tenantId, jobId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId) && Boolean(jobId),
    staleTime: EVIDENCE_STALE_MS,
    retry: false,
    queryFn: () => fetchMigrationVerificationEvidence(String(jobId)),
  });
}
