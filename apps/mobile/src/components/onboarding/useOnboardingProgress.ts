/**
 * useOnboardingProgressQuery — single TanStack Query for
 * GET /api/v1/onboarding-progress, shared by the dashboard checklist and
 * the adaptive product tour so they read identical server state without a
 * duplicate request.
 *
 * Read-only: the endpoint derives done-ness from row existence, so it's
 * safe to cache + refetch. Errors are swallowed by callers (older API
 * builds 404; the checklist + wizard simply hide / fall back).
 */
import { useQuery } from "@tanstack/react-query";

import {
  type OnboardingProgress,
  isGoalComplete,
  type ChecklistGoalKey,
} from "@postwave/onboarding-schema";

import { getMobileOnboardingProgress } from "@/api/mobileParity";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export const ONBOARDING_PROGRESS_QUERY_KEY = ["onboarding-progress"] as const;

/** Fetch the tenant's onboarding progress. Disabled while logged out. */
export function useOnboardingProgressQuery() {
  const gate = useOnlineQueryGate();
  return useQuery<OnboardingProgress>({
    queryKey: ONBOARDING_PROGRESS_QUERY_KEY,
    queryFn: async () => {
      const res = await getMobileOnboardingProgress();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    // A missing endpoint (older API) shouldn't retry-spam; one is plenty.
    retry: 1,
  });
}

/** A stable `isGoalDone(key)` predicate bound to a progress payload. */
export function makeIsGoalDone(
  progress: OnboardingProgress | null | undefined,
): (key: ChecklistGoalKey) => boolean {
  return (key) => isGoalComplete(progress, key);
}
