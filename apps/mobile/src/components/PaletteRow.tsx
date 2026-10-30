/**
 * PaletteRow — one row of the command palette / search results.
 *
 * Extracted from the Search screen so both halves of the palette (local
 * navigation + actions, and server entity hits) render at exactly the same
 * rhythm. When they were two inline renderers they drifted: the entity row had
 * no icon and the type label was a bare capitalised enum word floating at the
 * right edge with no visual container, so "Suppression" read as part of the
 * subtitle.
 *
 * NativeWind v4 gotcha: the Pressable takes a STATIC style object. The
 * `({pressed}) => …` form silently drops layout in this project.
 */
import { Pressable, Text, View } from "react-native";

import { TabBarIcon, type IconName } from "@/components/TabBarIcon";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface PaletteRowProps {
  title: string;
  subtitle?: string | undefined;
  icon: IconName;
  /** Short trailing tag: the hit's type, or "Action" for a local command. */
  badge?: string | undefined;
  onPress: () => void;
}

export function PaletteRow({
  title,
  subtitle,
  icon,
  badge,
  onPress,
}: PaletteRowProps) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      // The badge carries the only signal that distinguishes "Ada Lovelace the
      // subscriber" from "Ada the tag", so it belongs in the spoken label too.
      accessibilityLabel={badge ? `${title}. ${badge}` : title}
      {...(subtitle ? { accessibilityHint: subtitle } : {})}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 56,
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 8,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          backgroundColor: t.bgSubtle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <TabBarIcon name={icon} color={t.fgMuted} size={18} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          {...typeCap("body")}
          style={{ color: t.fg, fontFamily: FONT.medium, ...typeStyle("body") }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            {...typeCap("bodySmall")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
              marginTop: 2,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {badge ? (
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 999,
            backgroundColor: t.bgSubtle,
            borderWidth: 1,
            borderColor: t.borderSubtle,
          }}
        >
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.medium,
              ...typeStyle("badgeSmall"),
            }}
          >
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Group heading inside the palette's SectionList. */
export function PaletteSectionHeader({ title }: { title: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.semibold,
        ...typeStyle("caption"),
        letterSpacing: 0.6,
        textTransform: "uppercase",
        marginTop: 12,
        marginBottom: 8,
      }}
    >
      {title}
    </Text>
  );
}
