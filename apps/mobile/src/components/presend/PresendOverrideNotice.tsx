/**
 * PresendOverrideNotice — the line under the Send button that says WHY the
 * next tap opens a typed confirmation instead of sending.
 *
 * Purely presentational: the sheet decides whether an override is needed and
 * renders this only then; lib/presendOverrideNotice decides which reason is
 * named. Nothing here can block a send — the button above it keeps working
 * and this only explains its new label.
 *
 * Lives under components/presend rather than components/campaigns because
 * the route-test config stubs the latter to a null component, and this copy
 * is asserted by the two native suites that render the send sheet for real.
 *
 * Extracted from CampaignSendModal to keep that component under its
 * 300-line function budget (scripts/source-budgets.json).
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  presendOverrideReason,
  type PresendOverrideFlags,
} from "@/lib/presendOverrideNotice";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

export function PresendOverrideNotice(flags: PresendOverrideFlags) {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 10 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.danger,
          fontSize: 12,
          lineHeight: 17,
          fontFamily: FONT.medium,
        }}
      >
        {presendOverrideReason(flags)}
      </Text>
    </View>
  );
}
