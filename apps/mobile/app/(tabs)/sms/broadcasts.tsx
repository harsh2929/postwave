/**
 * SMS broadcasts — draft management route.
 *
 * The screen lives in `@/components/sms/SmsBroadcastsScreen`; this file is
 * the route registration. Registry row (mobileRoutesCore) is reported by the
 * batch that created this file — the route is linked from the SMS inbox.
 */
import { SmsBroadcastsScreen } from "@/components/sms/SmsBroadcastsScreen";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default SmsBroadcastsScreen;
