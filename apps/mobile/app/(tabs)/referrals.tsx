/**
 * Route boundary for the read-only Referrals inspection surface.
 *
 * See src/components/referrals/ReferralsScreen.tsx for what is reachable and
 * src/lib/referrals.ts for why the share sheet MAP#43 asked for is not.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { ReferralsScreen } from "@/components/referrals/ReferralsScreen";

export { AppErrorBoundary as ErrorBoundary };

export default function Referrals() {
  return <ReferralsScreen />;
}
