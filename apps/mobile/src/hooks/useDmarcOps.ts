/**
 * useDmarcOps — DMARC reports over an EXPLICIT window, plus the insights
 * rollup the screen previously ignored entirely.
 *
 * The old hook was `useDmarcReports(50)`: the newest 50 rows, whatever window
 * that happened to be. With one domain and three reporters that is about two
 * weeks; with five domains and six reporters it is under two days. The header
 * then summed pass/fail across it and printed the total with no denominator,
 * so the same number meant something different per tenant and per day.
 *
 * The SDK already types `{domain, from, to, limit}` and passes all four
 * through — nothing new was needed on the wire.
 *
 * Endpoints:
 *   GET /api/v1/deliverability/dmarc-reports?domain=&from=&to=&limit=
 *   GET /api/v1/deliverability/dmarc-insights?domain=&days=
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseDmarcInsights,
  parseDmarcReports,
  type DmarcInsights,
  type DmarcReport,
} from "@/lib/deliverabilityContracts";
import {
  loadSnapshotBacked,
  snapshotScope,
  type SnapshotBacked,
} from "@/lib/deliverabilitySnapshots";

export type { DmarcInsights, DmarcReport };

export type DmarcRangeKey = "7d" | "30d" | "90d";

export const DMARC_RANGES: readonly {
  value: DmarcRangeKey;
  label: string;
  days: number;
}[] = [
  { value: "7d", label: "7 days", days: 7 },
  { value: "30d", label: "30 days", days: 30 },
  { value: "90d", label: "90 days", days: 90 },
];

export function dmarcRangeDays(range: DmarcRangeKey): number {
  return DMARC_RANGES.find((r) => r.value === range)?.days ?? 30;
}

/** ISO date (UTC midnight) `days` ago — the window the summary describes. */
export function dmarcRangeStart(range: DmarcRangeKey, now = Date.now()): string {
  const start = new Date(now - dmarcRangeDays(range) * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

const REPORT_LIMIT = 200;

export function useDmarcReports(range: DmarcRangeKey, domain?: string) {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  const selectedDomain = (domain ?? "").trim();
  // Only the default view is worth persisting; a per-domain 90-day slice is
  // not "the DMARC data" and must not masquerade as the offline snapshot.
  const canonical = range === "30d" && selectedDomain === "";

  return useQuery({
    queryKey: [
      "dmarc",
      gate.tenantId,
      gate.userId,
      gate.enabled ? "network" : "snapshot",
      range,
      selectedDomain || "all",
    ],
    enabled: gate.canReadOfflineSnapshots,
    networkMode: "always",
    queryFn: (): Promise<SnapshotBacked<DmarcReport[]>> =>
      loadSnapshotBacked({
        resource: "dmarc-reports",
        scope,
        canUseNetwork: gate.enabled,
        persist: canonical,
        loadNetwork: async () => {
          const { client } = getClient();
          return parseDmarcReports(
            await client.dmarc.list({
              limit: REPORT_LIMIT,
              from: dmarcRangeStart(range),
              ...(selectedDomain ? { domain: selectedDomain } : {}),
            }),
          );
        },
        unavailableMessage:
          "No saved DMARC reports are available offline.",
      }),
  });
}

/**
 * The actionable half of DMARC: alignment trend, top failing sources and the
 * hand-tuned suggestions. Desktop's page comment states the redesign thesis
 * outright — the raw report list was demoted BELOW the insights so an operator
 * sees what to fix first. Mobile shipped only the demoted half.
 */
export function useDmarcInsights(domain: string, range: DmarcRangeKey) {
  const gate = useOnlineQueryGate();
  const selectedDomain = domain.trim();
  return useQuery({
    queryKey: ["dmarc-insights", gate.tenantId, selectedDomain, range],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && selectedDomain.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<DmarcInsights> => {
      const { client } = getClient();
      const query = new URLSearchParams({
        domain: selectedDomain,
        days: String(dmarcRangeDays(range)),
      });
      return parseDmarcInsights(
        await client.request<unknown>(
          "GET",
          `/api/v1/deliverability/dmarc-insights?${query.toString()}`,
        ),
      );
    },
  });
}
