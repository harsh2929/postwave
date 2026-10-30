/**
 * hooks/useAuditSinkOps.ts — audit-sink health + dead-letter reads
 * (COMMERCE#60).
 *
 * Carved out of the catch-all hooks/useOps.ts. The write half — reset a
 * tripped circuit, replay a dead-lettered batch, send a test event — already
 * lives in hooks/useGovernanceOps.ts, so this module is the read side of that
 * same incident surface and nothing else.
 *
 * Both queries are deliberately online-only. "Is the breaker still open?" has
 * no useful cached answer: the entire reason to open this screen is to learn
 * the CURRENT state before deciding whether to reset it.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchAuditSinkReplayJobs } from "@/api/auditSinks";
import {
  listMobileAuditSinkDlq,
  listMobileAuditSinks,
  type MobileAuditSink,
  type MobileAuditSinkDlqEntry,
} from "@/api/ops";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { opsTimestamp, unwrapMobileResult } from "@/lib/mobileOpsResult";

export type { MobileAuditSink, MobileAuditSinkDlqEntry };

/**
 * Unhealthy sinks first, then by failure count, then by name.
 *
 * Health leads because this list is read during an incident, and a phone shows
 * three rows before the fold. "Unhealthy" is disabled OR a non-closed circuit:
 * a sink someone switched off is just as silent as one whose breaker tripped,
 * and collapsing the two would let a manually disabled sink sit quietly at the
 * bottom of the list while audit events dropped on the floor.
 */
export function useMobileAuditSinks() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-audit-sinks", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<MobileAuditSink[]> => {
      const res = unwrapMobileResult(
        await listMobileAuditSinks(),
        "Audit sinks",
      );
      // Array.isArray, not `?? []`: this is UNPARSED wire data straight from
      // client.auditSinks.list(), and the nullish guard passes a truthy
      // non-array into the spread, which throws "Invalid attempt to spread
      // non-iterable instance" -- the crash api-keys shipped. Nothing between
      // the SDK and this line validates the shape.
      const sinks = Array.isArray(res.sinks) ? res.sinks : [];
      return [...sinks].sort((a, b) => {
        const aUnhealthy = !a.enabled || a.circuit_state !== "closed";
        const bUnhealthy = !b.enabled || b.circuit_state !== "closed";
        if (aUnhealthy !== bUnhealthy) return aUnhealthy ? -1 : 1;
        if (a.consecutive_failures !== b.consecutive_failures) {
          return b.consecutive_failures - a.consecutive_failures;
        }
        return a.name.localeCompare(b.name);
      });
    },
  });
}

/**
 * One sink's replay-job history, fetched only while its replay sheet is open.
 * `staleTime: 0` because the sheet is opened to answer "is the backfill still
 * running?", and a cached answer to that is the wrong answer.
 */
export function useSinkReplayJobs(sinkId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-sink-replay-jobs", gate.tenantId, sinkId],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(sinkId),
    staleTime: 0,
    queryFn: () => fetchAuditSinkReplayJobs(sinkId!),
  });
}

export function useMobileAuditSinkDlq() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-audit-sink-dlq", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<{
      entries: MobileAuditSinkDlqEntry[];
      count: number;
    }> => {
      const res = unwrapMobileResult(
        await listMobileAuditSinkDlq(),
        "Audit sink DLQ",
      );
      const entries = [...(res.entries ?? [])].sort(
        (a, b) =>
          opsTimestamp(b.last_attempt_at) - opsTimestamp(a.last_attempt_at),
      );
      // Never let the headline count under-report the rows we actually
      // render: a server `count: 0` alongside non-empty entries would make
      // the metric/empty-state disagree with the list.
      const serverCount = typeof res.count === "number" ? res.count : 0;
      return { entries, count: Math.max(serverCount, entries.length) };
    },
  });
}
