/**
 * SubscriberLifecyclePill — the funnel stage, beside the status pill.
 *
 * A per-subscriber lifecycle projection has been mounted with both a read
 * and a write since before mobile had a subscriber profile, and neither
 * client ever put it on one (desktop's card is the workspace-wide
 * distribution). It answers "where is this person in our funnel?" in one
 * enum, which is the shape a phone reads best.
 *
 * Renders NOTHING when the lookup fails or the payload has no recognisable
 * stage. A 404 is legitimate on an older gateway, and an error line beside
 * the status pill would look like a problem with the contact rather than
 * with the route.
 *
 * The score is shown as "3/5", so the spoken label carries the scale — a
 * bare "3" beside a stage name means nothing to a screen reader.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useSubscriberLifecycle } from "@/hooks/useSubscriberLifecycle";
import { FONT } from "@/lib/fonts";
import {
  lifecycleSpokenLabel,
  lifecycleStageLabel,
} from "@/lib/subscriberLifecycle";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberLifecyclePill({
  subscriberId,
}: {
  subscriberId: string;
}) {
  const { t } = useTheme();
  const lifecycle = useSubscriberLifecycle(subscriberId);
  const data = lifecycle.data;
  if (!data) return null;

  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
      accessible
      accessibilityLabel={lifecycleSpokenLabel(data)}
    >
      <Pill label={lifecycleStageLabel(data.stage)} tone="info" size="md" />
      <Text
        {...typeCap("badgeSmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("badgeSmall"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {`${data.score}/5`}
      </Text>
    </View>
  );
}
