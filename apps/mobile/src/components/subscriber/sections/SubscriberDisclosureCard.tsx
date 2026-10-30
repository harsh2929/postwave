/**
 * SubscriberDisclosureCard — the collapsed-until-asked card the profile's
 * compliance/data cluster keeps reusing.
 *
 * Every card in that cluster follows one contract: a titled disclosure that
 * starts CLOSED and fetches only when opened (a profile open must not fan out
 * a dozen ledger reads), announces its expanded state to VoiceOver, and never
 * renders a count it does not have. RecordHistoryCard grew the first copy of
 * this; the channel-consent / demographics / privacy cards would each have
 * grown their own, so the shell lives here once.
 */
import { Pressable, Text, View } from "react-native";

import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberDisclosureCard({
  title,
  hint,
  open,
  count,
  onToggle,
  children,
}: {
  title: string;
  /** One line under the title: what opening this reads. */
  hint: string;
  open: boolean;
  /** Loaded row count, or null while unknown. Never rendered as 0 when unknown. */
  count: number | null;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <Card style={{ marginTop: 12 }}>
      <Pressable
        onPress={() => {
          haptics.tap();
          onToggle();
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={count == null ? title : `${title}, ${count} entries`}
        accessibilityHint={hint}
        // NativeWind v4: static style object only.
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 44,
          gap: 12,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label>{title}</Label>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 2,
            }}
          >
            {hint}
          </Text>
        </View>
        <Text
          allowFontScaling={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: t.fgMuted, fontFamily: FONT.medium, fontSize: 16 }}
        >
          {open ? "▾" : "▸"}
        </Text>
      </Pressable>
      {open ? <View style={{ marginTop: 12 }}>{children}</View> : null}
    </Card>
  );
}

/** The one-line honest empty/notice text the disclosure bodies share. */
export function DisclosureEmptyLine({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
