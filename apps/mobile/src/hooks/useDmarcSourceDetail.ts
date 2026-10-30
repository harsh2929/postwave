/**
 * useDmarcSourceDetail — one failing source, opened.
 *
 * Runs only while a source sheet is showing (`ip` is set), so the list screen
 * never fans out one request per row.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchDmarcSourceDetail,
  type DmarcSourceDetail,
} from "@/api/dmarcSources";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function useDmarcSourceDetail(input: {
  ip: string;
  days: number;
  domain?: string;
}) {
  const gate = useOnlineQueryGate();
  const ip = input.ip.trim();
  return useQuery({
    queryKey: [
      "dmarc-source-detail",
      gate.tenantId,
      ip,
      input.days,
      input.domain ?? "",
    ],
    enabled: gate.enabled && Boolean(gate.tenantId) && ip.length > 0,
    staleTime: 5 * 60_000,
    queryFn: (): Promise<DmarcSourceDetail> =>
      fetchDmarcSourceDetail({
        ip,
        days: input.days,
        ...(input.domain ? { domain: input.domain } : {}),
      }),
  });
}
