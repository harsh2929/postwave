/**
 * DmarcPolicyAdvisorCard — what the observed p= policy means and what to do
 * next, with the observation-only boundary desktop's DmarcPolicyAdvisor
 * renders alongside every piece of advice.
 *
 * Pure copy over data the screen already has (the latest observed policy from
 * GET /deliverability/dmarc-insights); the decision table lives in
 * lib/dmarcView.ts (`dmarcPolicyAdvice`) so both the words and the branch
 * choice are node-tested.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { dmarcPolicyAdvice } from "@/lib/dmarcView";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function DmarcPolicyAdvisorCard({
  latestPolicy,
  domain,
}: {
  latestPolicy: string;
  domain: string;
}) {
  const { t } = useTheme();
  const advice = dmarcPolicyAdvice(latestPolicy, domain);

  return (
    <View
      accessible
      accessibilityLabel={`Policy advisor: ${advice.label}. ${advice.context}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.bold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          Policy advisor
        </Text>
        <Pill label={advice.label} tone="info" />
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {advice.context}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {advice.boundary}
      </Text>
    </View>
  );
}
