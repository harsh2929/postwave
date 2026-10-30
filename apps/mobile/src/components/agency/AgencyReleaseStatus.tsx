import { Text, View } from "react-native";

import { card } from "@/components/agency/agencyCardStyle";
import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const HELD_CAPABILITIES = [
  "Create a child workspace",
  "Unlink a child workspace",
  "Change the stored billing owner",
  "Preview consolidated billing",
  "Publish audit portal branding",
] as const;

export function AgencyReleaseStatus() {
  const { t } = useTheme();
  return (
    <View
      accessibilityLabel="Five agency capabilities are release-held. No write or billing-preview request is available."
      style={card(t)}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("heading")}
            style={{
              color: t.fg,
              ...typeStyle("heading"),
              fontFamily: FONT.semibold,
            }}
          >
            Held agency operations
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 4,
            }}
          >
            No mutation or invoice-preview request can be issued from this
            release.
          </Text>
        </View>
        <Pill label="5 held" tone="neutral" />
      </View>
      <View style={{ gap: 7, marginTop: 12 }}>
        {HELD_CAPABILITIES.map((label) => (
          <View
            key={label}
            accessible
            accessibilityLabel={`${label}. Release-held. No request available.`}
            style={{ flexDirection: "row", gap: 8 }}
          >
            <Text
              aria-hidden
              allowFontScaling={false}
              style={{ color: t.fgSubtle, fontFamily: FONT.regular }}
            >
              •
            </Text>
            <View style={{ flex: 1 }}>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                }}
              >
                {label}
              </Text>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                Release-held · no request available
              </Text>
            </View>
          </View>
        ))}
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 12,
        }}
      >
        Promotion requires atomic ownership and onboarding, proven payer
        handoff, qualified consolidated invoicing, and verified branding
        publication infrastructure.
      </Text>
    </View>
  );
}
