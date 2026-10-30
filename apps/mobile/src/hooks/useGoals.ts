/**
 * hooks/useGoals.ts — `GET /api/v1/goals/progress`.
 *
 * Read-only on the phone, deliberately. Setting a target is a planning act
 * with a period and a metric contract behind it (POST /api/v1/goals requires
 * the admin scope); CHECKING whether you are ahead of it is exactly the
 * glance a phone is for. The card says so rather than hiding an absent
 * affordance.
 *
 * Progress is computed live by the server on every call — nothing is
 * denormalised — so the answer is as current as the tiles above it. There is
 * no poll: a monthly target does not move in thirty seconds, and the screen's
 * pull-to-refresh already refetches every active query.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { parseGoalProgress, type GoalProgress } from "@/lib/goals";

export const GOALS_PROGRESS_PATH = "/api/v1/goals/progress";

/** Goals worth a glance on a phone; the desk shows the full list. */
export const MOBILE_GOALS_LIMIT = 4;

export function useGoalsProgress() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["dashboard-goals", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // Targets are monthly or quarterly. Re-asking every 30 seconds would tell
    // nobody anything, and this rides the same reports scope as the tiles.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<GoalProgress[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>("GET", GOALS_PROGRESS_PATH);
      return parseGoalProgress(res);
    },
  });
}
