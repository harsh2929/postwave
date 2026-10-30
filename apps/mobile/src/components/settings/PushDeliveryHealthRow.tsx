/**
 * PushDeliveryHealthRow — the difference between "the switch is on" and
 * "notifications are arriving".
 *
 * NATIVE#49. Everything the Settings push card showed came from the device:
 * a stored Expo token and an OS permission. When `receipts.go` deactivates a
 * row on a DeviceNotRegistered receipt — the ordinary outcome of an OS token
 * rotation — nothing local changes, so the switch kept reading ON while the
 * server had stopped sending. `POST /api/v1/mobile/push/devices/status` has
 * always been able to answer; nothing asked it.
 *
 * WHAT THIS DOES NOT DO. It never renders a negative it has not been told.
 * Offline, on an API-key install, or after a failed request the state is "Not
 * checked", because "we could not ask" and "delivery has stopped" are
 * different facts and only one of them should worry a user.
 *
 * A11Y: the state is a WORD, not a colour — the tone only tints text that
 * already says "Not delivering". The retry lives behind a 44pt target and
 * reports its result through the same toast the toggle uses.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useState } from "react";

import { useToast } from "@/components/Toast";
import { usePushDeviceStatus } from "@/hooks/usePushDeviceStatus";
import { announce } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  pushDeliveryCopy,
  pushDeliveryVerdict,
} from "@/lib/pushDeliveryHealth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface PushDeliveryHealthRowProps {
  /** The device has a token AND OS permission — what the switch shows. */
  locallyEnabled: boolean;
  /** Re-runs registration. Resolves true when the device is registered. */
  onReRegister: () => Promise<boolean>;
}

export function PushDeliveryHealthRow({
  locallyEnabled,
  onReRegister,
}: PushDeliveryHealthRowProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const status = usePushDeviceStatus({ locallyEnabled });
  const [retrying, setRetrying] = useState(false);

  const verdict = pushDeliveryVerdict({
    locallyEnabled,
    // `undefined` (never fetched) and a failed fetch both mean UNKNOWN. Only a
    // resolved response is allowed to produce a negative verdict.
    facts: status.isSuccess ? (status.data ?? null) : null,
  });
  const copy = pushDeliveryCopy(verdict);
  if (verdict.kind === "off") return null;

  const toneColor =
    copy.tone === "warning"
      ? t.warning
      : copy.tone === "success"
        ? t.success
        : t.fgMuted;

  async function reRegister(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      const ok = await onReRegister();
      if (ok) {
        haptics.success();
        toast({ kind: "success", message: "This device is registered again." });
        announce("This device is registered for push again.");
      } else {
        haptics.error();
        toast({
          kind: "error",
          message: "Couldn't re-register this device for push.",
        });
      }
    } finally {
      setRetrying(false);
      await status.refetch();
    }
  }

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Server delivery
        </Text>
        {status.isFetching && !status.isSuccess ? (
          <ActivityIndicator color={t.fgMuted} />
        ) : (
          <Text
            accessibilityLabel={`Server delivery: ${copy.state}`}
            {...typeCap("bodySmall")}
            style={{
              color: toneColor,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
            testID="push-delivery-state"
          >
            {copy.state}
          </Text>
        )}
      </View>

      {copy.message ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {copy.message}
        </Text>
      ) : null}

      {copy.offerRetry ? (
        <Pressable
          onPress={() => void reRegister()}
          disabled={retrying}
          accessibilityRole="button"
          accessibilityLabel="Re-register this device for push"
          accessibilityState={{ disabled: retrying, busy: retrying }}
          hitSlop={8}
          style={{
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingVertical: 4,
            opacity: retrying ? 0.6 : 1,
          }}
          testID="push-delivery-reregister"
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.accent,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {retrying ? "Re-registering…" : "Re-register this device"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
