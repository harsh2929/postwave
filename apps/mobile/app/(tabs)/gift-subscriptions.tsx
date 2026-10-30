/** Route boundary for the read-only, privacy-minimized Gift history archive. */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { GiftSubscriptionsScreen } from "@/components/gift-subscriptions/GiftSubscriptionsScreen";

export { AppErrorBoundary as ErrorBoundary };

export default function GiftSubscriptions() {
  return <GiftSubscriptionsScreen />;
}
