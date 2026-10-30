/**
 * MaintenanceBanner — "why is nothing sending?", half of the answer.
 *
 * `maintenance.go` (list / create / patch / delete, all admin) had a desktop
 * client and nothing on mobile. Authoring a window from a phone is not worth
 * building — scheduling downtime is planning work — but knowing a window is
 * OPEN RIGHT NOW is the same class of fact as a tenant pause, and an operator
 * who checks one without the other draws a confident wrong conclusion from
 * whichever they looked at.
 *
 * It sits at the top of the dashboard because that is where the question gets
 * asked, and above the metrics because a metric read during maintenance means
 * something different from the same metric read outside one.
 *
 * SELF-GATING, like the strips around it: nothing renders when no window is
 * open or imminent. A permanent "no maintenance scheduled" line is exactly the
 * kind of always-green furniture that teaches a reader to skip the region on
 * the one morning it says something else.
 */
import { Text, View } from "react-native";

import { useMaintenanceWindows } from "@/hooks/useComplianceOps";
import { maintenanceBanner } from "@/lib/complianceOps";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function MaintenanceBanner() {
  const { t } = useTheme();
  const query = useMaintenanceWindows();
  const message = maintenanceBanner(query.data ?? []);
  if (!message) return null;

  return (
    <View
      // An open maintenance window changes how everything below it should be
      // read, so it is announced rather than merely present.
      accessibilityRole="alert"
      style={{
        backgroundColor: t.surface,
        borderColor: t.warning,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 12,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.warning,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
        }}
      >
        {message}
      </Text>
    </View>
  );
}
