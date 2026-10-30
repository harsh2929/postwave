/**
 * FailingSourcesCard — the top failing DMARC sources by IP, each one openable.
 *
 * Extracted from DmarcInsightsCard when the tap-through landed (that file sits
 * at its source-budget ceiling). A row press hands the IP to the parent, which
 * presents DmarcSourceSheet — the drill-down that separates a forwarder from
 * a legitimate ESP from spoofing. Without `onOpenSource` the rows render
 * exactly as before: a list, no dead affordance.
 */
import { Pressable, Text, View } from "react-native";

import type { DmarcInsights } from "@/lib/deliverabilityContracts";
import { FONT } from "@/lib/fonts";
import { num, percent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function FailingSourcesCard({
  sources,
  onOpenSource,
}: {
  sources: DmarcInsights["topFailingSources"];
  onOpenSource?: ((ip: string) => void) | undefined;
}) {
  const { t } = useTheme();
  if (sources.length === 0) return null;
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
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
        Top failing sources
      </Text>
      {sources.slice(0, 5).map((source) => {
        const row = (
          <>
            <Text
              {...typeCap("mono")}
              style={{
                color: t.fg,
                ...typeStyle("mono"),
                fontFamily: "Menlo",
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {source.sourceIp}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgMuted,
                ...typeStyle("numeric"),
                fontFamily: FONT.regular,
                fontVariant: ["tabular-nums"],
              }}
            >
              {`${num(source.messages)} msg · ${percent(source.alignedPct, { digits: 0 })} aligned`}
            </Text>
          </>
        );
        const label = `${source.sourceIp}, ${num(source.messages)} messages, ${percent(source.alignedPct, { digits: 0 })} aligned, mostly ${source.primaryDisposition}`;
        if (!onOpenSource) {
          return (
            <View
              key={source.sourceIp}
              accessible
              accessibilityLabel={label}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              {row}
            </View>
          );
        }
        return (
          <Pressable
            key={source.sourceIp}
            onPress={() => onOpenSource(source.sourceIp)}
            accessibilityRole="button"
            accessibilityLabel={`${label}. Open source detail`}
            hitSlop={8}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              minHeight: 44,
            }}
          >
            {row}
          </Pressable>
        );
      })}
    </View>
  );
}
