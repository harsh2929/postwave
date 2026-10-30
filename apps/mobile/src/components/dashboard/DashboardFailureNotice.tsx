/**
 * DashboardFailureNotice — renders the ONE right thing for a failed stats load.
 *
 * The four cases are materially different and the screen used to flatten them
 * into a red card carrying the raw transport string:
 *
 *  1. A PERMISSION BOUNDARY (403) gets a flat notice with no retry. Retrying is
 *     a button that can never work, and the copy names the boundary rather than
 *     claiming the product is broken.
 *  2. A METRICS-HIDING FAILURE THAT *CAN* BE RECOVERED FROM — an expired
 *     session — keeps its retry. It hides the tiles for the same reason a 403
 *     does (a grid of em-dashes reads as "your workspace is empty"), but it is
 *     not a role problem and must not be titled as one, or the user goes asking
 *     an admin for something only signing in again fixes.
 *  3. A FAILED REFRESH OVER CACHED FIGURES is a staleness banner, sitting
 *     directly above the numbers it invalidates. Replacing readable cached data
 *     with an error card destroys good content over one bad poll.
 *  4. ANYTHING ELSE with nothing cached is the full error state.
 *
 * `failure.message` is always the taxonomy's stable copy — never the SDK's
 * string — so nothing here can leak transport internals at the user.
 */
import { View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { hidesMetrics, type DashboardFailure } from "@/lib/dashboardFailure";

export interface DashboardFailureNoticeProps {
  failure: DashboardFailure | null;
  /** True when cached figures are still on screen behind this failure. */
  hasCachedData: boolean;
  onRetry: () => void;
}

export function DashboardFailureNotice({
  failure,
  hasCachedData,
  onRetry,
}: DashboardFailureNoticeProps) {
  if (!failure) return null;

  if (hidesMetrics(failure)) {
    return failure.retryLabel ? (
      <View style={{ marginBottom: 12 }}>
        <ErrorState message={failure.message} onRetry={onRetry} />
      </View>
    ) : (
      <MobileScopeNotice title={failure.title} body={failure.message} />
    );
  }

  if (hasCachedData) {
    return <StaleDataBanner onRetry={onRetry} message={failure.message} />;
  }

  return (
    <View style={{ marginBottom: 12 }}>
      <ErrorState
        message={failure.message}
        {...(failure.retryLabel ? { onRetry } : {})}
      />
    </View>
  );
}
