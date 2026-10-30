/**
 * Avatar — a coloured initial for a subscriber.
 *
 * Desktop ships an avatar column by default; mobile rendered a raw email
 * address and nothing else, so a scrolling list had no visual anchor. The
 * hue is derived from the email (src/lib/subscriberIdentity.ts) so the
 * same person is the same colour on every screen and across restarts.
 *
 * Accessibility: the circle is decorative — the row's own label already
 * speaks the name and address — so it is hidden from assistive tech
 * rather than announcing a stray "AL".
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  subscriberAvatarHue,
  subscriberInitials,
  type SubscriberIdentityFields,
} from "@/lib/subscriberIdentity";
import { useTheme } from "@/lib/theme";

export function Avatar({
  subscriber,
  size = 32,
}: {
  subscriber: SubscriberIdentityFields;
  size?: number;
}) {
  const { theme } = useTheme();
  const hue = subscriberAvatarHue(subscriber);
  const initials = subscriberInitials(subscriber);
  // Dark theme needs a lighter foreground on a darker chip; light theme
  // the reverse. Saturation stays low so a dozen of these in a column read
  // as one family rather than a bag of highlighters.
  const dark = theme === "dark";
  const backgroundColor = `hsl(${hue}, 45%, ${dark ? 22 : 90}%)`;
  const color = `hsl(${hue}, 55%, ${dark ? 78 : 30}%)`;

  return (
    <View
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* `allowFontScaling={false}` is correct here and only here: the
          initials are a DECORATIVE glyph standing in for an icon (the node is
          already hidden from assistive tech, and the row's own label speaks
          the name), and the size is derived from the circle's diameter — a
          scaled initial would simply overflow a container it can never
          resize. Content text in this cluster is on the type scale instead. */}
      <Text
        allowFontScaling={false}
        style={{
          color,
          fontSize: Math.round(size * 0.4),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
        numberOfLines={1}
      >
        {initials}
      </Text>
    </View>
  );
}
