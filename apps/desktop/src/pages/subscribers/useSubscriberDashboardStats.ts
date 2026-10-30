import { useEffect, useState } from "react";

import { type DashboardStatsResponse, api } from "../../lib/api-client";

export function useSubscriberDashboardStats(
  identityScope: string | null,
): DashboardStatsResponse | null {
  const [ownedStats, setOwnedStats] = useState<{
    identity: string | null;
    data: DashboardStatsResponse;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOwnedStats(null);
    void (async () => {
      const response = await api.getDashboardStats({
        range: "30d",
        compare: false,
        sparklines: false,
      });
      if (cancelled) return;
      if (response.data) {
        setOwnedStats({ identity: identityScope, data: response.data });
      } else if (response.error) {
        // eslint-disable-next-line no-console
        console.warn("Subscribers: dashboard stats fetch failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identityScope]);

  return ownedStats?.identity === identityScope ? ownedStats.data : null;
}
