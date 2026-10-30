/**
 * WhatsNewCard — the one dismissible product announcement on More.
 *
 * Mobile's twin of desktop's SidebarCallout: an eyebrow, one sentence, a CTA
 * that lands on the feature, and an X. It renders at most one card, and it
 * renders NOTHING for the common case (no live announcement, or the user has
 * put them all down), so a phone that has seen everything looks exactly like
 * the screen before this shipped.
 *
 * The card and the row badges are the same mechanism: both read
 * `lib/whatsNew.ts` over `lib/newFeatures.ts`, so a feature cannot be
 * announced here without its More row wearing the pill, and neither can
 * outlive the shared 30-day window.
 *
 * ACCESSIBILITY. The card is one accessible element carrying the feature name
 * and the sentence (`announcementSpoken`), because a bare "What's new" eyebrow
 * followed by an unattributed sentence reads as two orphans. The dismiss
 * control is separate, labelled with what it dismisses rather than "Close".
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { useWhatsNew } from "@/hooks/useWhatsNew";
import { announce } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { newFeatureLabel } from "@/lib/newFeatures";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { announcementSpoken } from "@/lib/whatsNew";

export function WhatsNewCard({
  effectiveRole,
  mode,
  onOpen,
}: {
  effectiveRole: string | null;
  mode: "api_key" | "session" | null;
  /** Records the visit so the destination joins the Recent list, as a row tap does. */
  onOpen?: ((routeKey: string) => void) | undefined;
}) {
  const { t } = useTheme();
  const whatsNew = useWhatsNew({ effectiveRole, mode });
  const item = whatsNew.item;
  if (!item || !whatsNew.route) return null;
  const route = whatsNew.route;

  return (
    <View
      style={{
        marginHorizontal: 12,
        marginBottom: 20,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        paddingHorizontal: 14,
        paddingTop: 12,
        paddingBottom: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View accessible accessibilityLabel={announcementSpoken(item)} style={{ flex: 1 }}>
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: t.accent,
              ...typeStyle("badgeSmall"),
              fontFamily: FONT.semibold,
              letterSpacing: 0.6,
              marginBottom: 4,
            }}
          >
            WHAT&apos;S NEW
          </Text>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.medium,
            }}
          >
            {item.title}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            haptics.tap();
            const label = newFeatureLabel(item.featureKey);
            whatsNew.dismiss();
            announce(label ? `Dismissed ${label}` : "Dismissed");
          }}
          accessibilityRole="button"
          accessibilityLabel={`Dismiss this announcement about ${
            newFeatureLabel(item.featureKey) || "a new feature"
          }`}
          hitSlop={10}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            marginTop: -8,
            marginEnd: -8,
          }}
        >
          {/* Decorative glyph inside a 44pt target — the meaning lives on the
              button's accessibility label, as on the onboarding checklist. */}
          <Text
            allowFontScaling={false}
            style={{ color: t.fgSubtle, fontSize: 18, fontFamily: FONT.regular }}
          >
            ×
          </Text>
        </Pressable>
      </View>
      <Pressable
        onPress={() => {
          haptics.tap();
          onOpen?.(item.routeKey);
          router.push(route as never);
        }}
        accessibilityRole="button"
        accessibilityLabel={item.ctaLabel}
        style={{
          alignSelf: "flex-start",
          minHeight: 44,
          justifyContent: "center",
          paddingVertical: 8,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {item.ctaLabel}
        </Text>
      </Pressable>
    </View>
  );
}
