/**
 * The inbox keeps campaign dispatch visibly release-held.
 *
 * Production does not currently expose a qualified mobile broadcast-readiness
 * composition, so mounting this boundary must not fetch campaign data or offer
 * queue/resume/retry controls. Conversation browsing remains independent.
 *
 * THE GATE CODE IS NOT COPY. The second sentence used to end
 * "…(sms_broadcast_dispatch_release_held)", printing a server-side identifier
 * at an operator who has no use for it. The explanation was already complete
 * without it. The code now hangs off the boundary as a `testID` — diagnostic,
 * machine-readable, and never read aloud or on screen.
 */
import { Text, View } from "react-native";

import { SMS_BROADCAST_DISPATCH_RELEASE_HELD_CODE } from "@/api/smsCampaigns";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsCampaignControls() {
  const { t } = useTheme();
  return (
    <View
      accessibilityRole="summary"
      testID={`sms-campaign-hold-${SMS_BROADCAST_DISPATCH_RELEASE_HELD_CODE}`}
      style={{
        borderColor: t.borderSubtle,
        borderRadius: 12,
        borderWidth: 1,
        gap: 4,
        padding: 12,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Campaign dispatch is release-held
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Queue, schedule, resume, retry, and test-send controls are unavailable.
        No campaign request is made from this inbox.
      </Text>
    </View>
  );
}
