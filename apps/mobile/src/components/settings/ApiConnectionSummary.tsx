/**
 * ApiConnectionSummary — the read-only "you're signed in with a session
 * cookie" card that ApiConnectionSection shows instead of the API-key form.
 *
 * Split out of that file, which had reached its 450-line hard ceiling. The
 * split is on a real seam: this branch renders no inputs, owns no state and
 * makes no requests — it is the summary, and everything left behind is the
 * editor.
 *
 * NativeWind v4 gotcha: static Pressable style objects only; the
 * `({ pressed }) => …` form silently drops layout.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/settings/SettingsScreenPrimitives";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ApiConnectionSummary({
  baseUrl,
  tenantLabel,
  onUseApiKey,
  onShare,
}: {
  baseUrl: string | null;
  tenantLabel: string;
  onUseApiKey: () => void;
  onShare: () => void;
}) {
  const { t } = useTheme();
  return (
    <Card>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: t.success,
          }}
        />
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Connected via session cookie
        </Text>
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          marginBottom: 10,
          fontFamily: FONT.regular,
        }}
      >
        {baseUrl ? `${baseUrl} · ${tenantLabel}` : ""}
        {"\n"}
        {"\n"}
        Subscribers, campaigns, audit, and other data tabs are authenticated by
        your sign-in session — no API key needed.
      </Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <SummaryButton
          label="Use an API key on this device instead"
          onPress={onUseApiKey}
        />
        <SummaryButton
          label="Share details"
          accessibilityLabel="Share connection details"
          onPress={onShare}
        />
      </View>
    </Card>
  );
}

function SummaryButton({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string | undefined;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
        alignSelf: "flex-start",
      }}
    >
      <Text
        // Button label inside a wrapping row of buttons: it reflows with the
        // row rather than sharing a fixed width, so it takes a prose ceiling.
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
