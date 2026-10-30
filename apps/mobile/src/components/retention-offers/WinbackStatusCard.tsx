/**
 * WinbackStatusCard renders stored configuration and scoring coverage only.
 * Neither `enabled` nor `churn_profiles_scored` proves that the uncomposed
 * outbound worker enrolled somebody or delivered anything.
 *
 * READ-ONLY BY SERVER DESIGN. `PUT /winback-settings` exists in the package
 * and is registered on no router — `retention_offers.Deps.MountRoutes` mounts
 * the GET alone. A toggle here would be a switch wired to nothing.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { num, percent } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { WinbackSettings } from "@/lib/retentionOffers";
import {
  RETENTION_WINBACK_RELEASE_HOLD_CODE,
  RETENTION_WINBACK_RELEASE_VERDICT,
} from "@/lib/retentionWinbackReleaseStatus";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function WinbackStatusCard({
  settings,
  unavailable,
}: {
  /** null means no verified settings payload is available. */
  settings: WinbackSettings | null;
  unavailable: boolean;
}) {
  const { t } = useTheme();

  if (settings === null) {
    return (
      <View
        accessible
        accessibilityLabel={
          unavailable
            ? "Stored win-back settings didn't load, so their configuration is unknown."
            : "Stored win-back settings came back in a shape the app couldn't read."
        }
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
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
          {/* Not "Win-backs are off" — that is a claim about the workspace
              this card has no evidence for. */}
          Stored win-back configuration unknown — the settings didn&apos;t load.
        </Text>
      </View>
    );
  }

  const scored = settings.churnProfilesScored;
  const storedState = settings.enabled ? "enabled" : "disabled";
  const detail = `The stored switch is ${storedState} at a ${percent(settings.churnThreshold)} threshold; ${num(scored)} profiles are recorded as scored. Automated delivery is ${RETENTION_WINBACK_RELEASE_VERDICT} (${RETENTION_WINBACK_RELEASE_HOLD_CODE}), so no enrollment or dispatch can be inferred.`;

  return (
    <View
      accessible
      accessibilityLabel={`Churn win-backs. Stored switch ${storedState}. ${detail}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            flex: 1,
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Churn win-backs
        </Text>
        <Pill
          label={settings.enabled ? "Stored enabled" : "Stored disabled"}
          tone={settings.enabled ? "warning" : "neutral"}
        />
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {detail}
      </Text>
    </View>
  );
}
