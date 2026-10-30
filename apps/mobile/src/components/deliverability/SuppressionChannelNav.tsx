/**
 * SuppressionChannelNav — one control for the three suppression channels.
 *
 * Suppression is not one table. Email lives in `deliverability_suppressions`,
 * SMS in the TCPA opt-out table, and push in the tenant-customer APNs/FCM/Web
 * authority registry — different routes, vocabularies, and legal weight. The
 * push registry is unrelated to this operator app's Expo notification device.
 *
 * Email and Push render in place on this screen; they are both flat lists with
 * one action. SMS NAVIGATES, because the SMS screen is not just a list: it
 * carries quiet-hours windows and keyword auto-replies, which are the same
 * concern ("what happens when we text this number") and belong together. The
 * control therefore reports its selected value as the in-place channel and
 * treats "sms" as a destination — the same pattern AudienceNav uses across the
 * audience surfaces.
 */
import { router } from "expo-router";

import { SegmentedControl } from "@/components/SegmentedControl";
import {
  canAccessMobileSecondaryRoute,
  MOBILE_SECONDARY_ROUTES,
} from "@/lib/mobileRouteManifest";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useAuthStore } from "@/store/auth";

export type SuppressionChannel = "email" | "push";

const SMS_ROUTE = "/(tabs)/sms/suppressions";

export function SuppressionChannelNav({
  value,
  onChange,
}: {
  value: SuppressionChannel;
  onChange: (next: SuppressionChannel) => void;
}) {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);

  // Only offer SMS when this role can actually open that screen — a segment
  // that navigates into a role guard is a dead end dressed as a destination.
  const smsRoute = MOBILE_SECONDARY_ROUTES.find((r) => r.route === SMS_ROUTE);
  const showSms = smsRoute
    ? canAccessMobileSecondaryRoute(smsRoute, gate.effectiveRole, mode)
    : false;

  const options = [
    { value: "email", label: "Email" },
    ...(showSms ? [{ value: "sms", label: "SMS" }] : []),
    { value: "push", label: "Push" },
  ];

  return (
    <SegmentedControl
      accessibilityLabel="Suppression channel"
      options={options}
      value={value}
      onChange={(next) => {
        if (next === "sms") {
          router.push(SMS_ROUTE);
          return;
        }
        onChange(next as SuppressionChannel);
      }}
    />
  );
}
