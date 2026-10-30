/**
 * MoreDesktopOnly — the closing block of the More menu (MAP#73).
 *
 * Six section headings over 55 rows read as an inventory of the product. They
 * are not one, and the menu had no way to say so. This block says it: a short
 * heading, one sentence of why, and the named capabilities that live on
 * desktop and web.
 *
 * THREE DELIBERATE NON-FEATURES:
 *
 *  - No rows are pressable. Every one of these is a screen this app does not
 *    have, so a tap could only ever open a browser or apologise; a row that
 *    looks like a destination and is not is worse than plain text.
 *  - No "coming soon". The app cannot keep that promise and a menu that makes
 *    six of them is a menu you stop reading.
 *  - It renders LAST and only when the user is not filtering. While a filter
 *    is active the screen is answering "where is X", and a block that is
 *    permanently unfiltered would be noise under every search.
 *
 * A11y: the whole block is one node with one spoken label. Six unlabelled
 * text pairs would reach VoiceOver as orphaned phrases with no explanation of
 * why the app is listing things it cannot do.
 *
 * NativeWind v4: STATIC styles only — the `({pressed}) => …` form silently
 * drops layout, and there is no Pressable here at all.
 */
import { Text, View } from "react-native";

import { cardOuter, sectionLabel } from "@/components/more/moreStyles";
import {
  desktopOnlyAccessibilityLabel,
  desktopOnlyBody,
  desktopOnlyHeading,
  desktopOnlyRows,
} from "@/lib/desktopOnlyCapabilities";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function MoreDesktopOnly() {
  const { t } = useTheme();
  const rows = desktopOnlyRows();
  if (rows.length === 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={desktopOnlyAccessibilityLabel()}
      style={cardOuter(t)}
    >
      <Text {...typeCap("label")} style={sectionLabel(t)}>
        {desktopOnlyHeading()}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginBottom: 10,
        }}
      >
        {desktopOnlyBody()}
      </Text>
      {rows.map((row) => (
        <View key={row.section} style={{ marginBottom: 8 }}>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.medium,
            }}
          >
            {row.label}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {row.hint}
          </Text>
        </View>
      ))}
    </View>
  );
}
