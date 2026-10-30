/**
 * DigestPrefsSection — the dashboard email digest cadence.
 *
 * Desktop renders this against GET/PUT /api/v1/dashboard/digest. Mobile had no
 * client for it at all: its NotificationPreferencesSection covers
 * /api/v1/settings/notifications, a different and coarser control, so the one
 * lever that actually governs how much email Moosewave sends YOU could not be
 * touched from a phone.
 *
 * Optimistic with rollback, matching the pattern the notification-preferences
 * section already established — a cadence chip that waits for a round trip
 * before moving reads as an unresponsive control.
 */
import { useEffect, useState } from "react";

import {
  DIGEST_FREQUENCIES,
  getDigestPrefs,
  normalizeDigestFrequency,
  putDigestPrefs,
  type DigestFrequency,
} from "@/api/settingsExtras";
import { Chip } from "@/components/Chip";
import { Card } from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { Text, View } from "react-native";

type LoadState = "loading" | "ready" | "unavailable" | "failed" | "offline";

export function DigestPrefsSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>("loading");
  const [frequency, setFrequency] = useState<DigestFrequency>("off");

  useEffect(() => {
    let cancelled = false;
    if (!gate.enabled || !gate.tenantId) {
      // Not a failure: nothing is broken, the device just can't ask. Saying
      // "couldn't load" here would blame the workspace for a subway tunnel.
      setState("offline");
      return;
    }
    setState("loading");
    void getDigestPrefs().then((res) => {
      if (cancelled) return;
      if (res.error) {
        // An older deployment simply doesn't have the endpoint; saying
        // "unavailable on this deployment" is honest, "failed" would not be.
        setState(
          res.error.status === 404 || res.error.status === 501
            ? "unavailable"
            : "failed",
        );
        return;
      }
      setFrequency(normalizeDigestFrequency(res.data?.frequency));
      setState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [gate.enabled, gate.tenantId]);

  const choose = (next: DigestFrequency) => {
    if (next === frequency) return;
    const previous = frequency;
    haptics.tap();
    setFrequency(next);
    void putDigestPrefs(next).then((res) => {
      if (res.error) {
        setFrequency(previous);
        toast({ kind: "error", message: "Couldn't save the digest cadence." });
        return;
      }
      toast({
        kind: "success",
        message:
          next === "off" ? "Digest turned off." : `Digest set to ${next}.`,
      });
    });
  };

  if (state === "loading") {
    return (
      <Card>
        <SkeletonList rows={1} lines={2} label="Loading digest preferences" />
      </Card>
    );
  }
  if (state !== "ready") {
    return (
      <Card>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {state === "unavailable"
            ? "Dashboard digest is unavailable on this deployment."
            : state === "offline"
              ? "Reconnect to load the digest cadence."
              : "Couldn't load the digest cadence. Pull to refresh to try again."}
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {DIGEST_FREQUENCIES.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            active={frequency === option.value}
            accessibilityLabel={`Digest ${option.label}`}
            onPress={() => choose(option.value)}
          />
        ))}
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 8,
          fontFamily: FONT.regular,
        }}
      >
        A rollup of workspace activity, emailed to you. Off means Moosewave never
        sends it.
      </Text>
    </Card>
  );
}
