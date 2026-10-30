/**
 * ScreenHeader — the inline 56px header that replaces the native Stack
 * title. Every tab root and detail screen renders one of these at the
 * top of its body, BEFORE the ScrollView, so the title doesn't scroll
 * away with content.
 *
 * Pattern (use this exactly):
 *
 *   <SafeAreaView edges={["top"]} style={{ backgroundColor: t.bg }}>
 *     <ScreenHeader title="Dashboard" right={<LiveDot live />} />
 *     <ScrollView>...</ScrollView>
 *   </SafeAreaView>
 *
 * For non-root screens (e.g. campaigns/[id]), pass `onBack` so a chevron
 * renders on the left.
 */
import {
  I18nManager,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useState, type ReactNode } from "react";
import { router } from "expo-router";

import { ScreenHeaderStatus } from "@/components/ScreenHeaderStatus";
import { TabBarIcon } from "@/components/TabBarIcon";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

interface ScreenHeaderProps {
  title: string;
  /** Optional muted line under the title (workspace, count, etc). */
  subtitle?: string | undefined;
  /** Optional right-side slot: live dot, action button, etc. */
  right?: ReactNode;
  /** When set, renders a back chevron and calls this on tap. */
  onBack?: (() => void) | undefined;
  /**
   * Renders a magnifier to the LEFT of the `right` slot.
   *
   * The search screen previously had no entry point in app chrome at all — it
   * was reachable only by scrolling the More list to "Tools" — while desktop
   * renders a persistent search button with a ⌘K hint on every screen. Pass
   * `true` for the default "go to the search screen" behaviour, or a function
   * to open a screen-local search instead.
   */
  onSearch?: boolean | (() => void) | undefined;
  /**
   * Suppress the shell status pill (viewer preview / cached connection).
   *
   * Default is to show it on every screen — that is the whole point of a
   * persistent indicator. Opt out only where the header is already the subject
   * of the state being reported.
   */
  hideStatus?: boolean | undefined;
}

export function ScreenHeader({
  title,
  subtitle,
  right,
  onBack,
  onSearch,
  hideStatus,
}: ScreenHeaderProps) {
  const { t } = useTheme();
  const [backPressed, setBackPressed] = useState(false);
  const [searchPressed, setSearchPressed] = useState(false);
  // Capping the multiplier alone still leaves "Deliverability settings" as
  // "Deliverab…" at the accessibility sizes. Above the threshold the header
  // spends a second line instead of eating the title.
  const { fontScale } = useWindowDimensions();
  const titleLines = maxLinesAtScale(1, fontScale);
  const search =
    onSearch === true
      ? () => router.push("/(tabs)/search")
      : typeof onSearch === "function"
        ? onSearch
        : null;
  // Back is the single highest-frequency navigation gesture in an app whose
  // detail screens all hand-roll their own chevron. It was the ONE control in
  // the shell with no physical confirmation, so moving between screens felt
  // inert while everything inside a screen did not.
  const back = onBack
    ? () => {
        haptics.tap();
        onBack();
      }
    : null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingTop: 6,
        paddingBottom: 10,
        backgroundColor: t.bg,
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", flex: 1, gap: 8 }}
      >
        {back ? (
          <Pressable
            onPressIn={() => setBackPressed(true)}
            onPressOut={() => setBackPressed(false)}
            onPress={back}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={12}
            android_ripple={{ color: t.borderSubtle, borderless: false }}
            // NativeWind v4 drops callback-style Pressable layout. Keep one
            // static object and let state change paint only the fill.
            style={{
              opacity: 1,
              borderRadius: 10,
              overflow: "hidden",
              backgroundColor: backPressed ? t.accentSubtle : "transparent",
              // `paddingEnd`, not `paddingRight`: AndroidManifest declares
              // supportsRtl=true, so on an RTL locale the header row mirrors
              // and this gap has to follow the chevron to the other side.
              paddingEnd: 4,
            }}
          >
            <Chevron color={t.fg} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          <Text
            // THE screen heading. Every tab root and detail screen renders one
            // of these, so this single attribute is what populates VoiceOver's
            // rotor "Headings" mode app-wide — without it the rotor found
            // nothing on any screen and a screen-reader user had to swipe
            // through every element to skim a 900-line settings page.
            accessibilityRole="header"
            style={{
              color: t.fg,
              ...typeStyle("display"),
              fontFamily: FONT.display,
              letterSpacing: -0.4,
            }}
            numberOfLines={titleLines}
            // The `display` role owns the ceiling now (1.4x) rather than this
            // call site owning a magic number: a 24pt title at the largest
            // accessibility size would be 50pt, while body copy elsewhere is
            // free to go most of the way.
            {...typeCap("display")}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              // The header subtitle is where most list screens put their
              // RESULT COUNT ("42 shown", "7 suppressed addresses"), and it
              // changed silently: a VoiceOver user tapped a filter chip and
              // received no confirmation that anything had happened. A polite
              // live region announces the new count on change and stays quiet
              // for the static subtitles (workspace name, plan) that never
              // change — the same treatment SubscribersListHeader and
              // ApprovalSummary already carry, now applied at the one place
              // every screen draws.
              accessibilityLiveRegion="polite"
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                marginTop: 2,
                fontFamily: FONT.regular,
              }}
              numberOfLines={titleLines}
              {...typeCap("bodySmall")}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {search || right || !hideStatus ? (
        <View
          style={{
            // Logical, not physical: the right slot becomes the LEFT slot on
            // an RTL locale and the gap has to travel with it.
            marginStart: 12,
            // SHRINKABLE, and capped. With flexShrink: 0 this slot never
            // yielded, so the TITLE -- the screen's own name, and the only
            // thing telling the reader where they are -- absorbed all the
            // pressure and truncated instead. On the dashboard that read
            // "Dashboa…" beside a full-width "RECONNECTING" pill, and the same
            // title rendered fine once the pill said the shorter "ON TIMER".
            // Observed in-app on 2026-08-19.
            //
            // A status pill is supplementary; the title is identity. The cap
            // keeps the slot from eating the row on a long label while still
            // leaving room for the search + action buttons.
            flexShrink: 1,
            maxWidth: "58%",
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
          }}
        >
          {/* Renders null on the healthy path, so this costs no layout until
              the app is actually in viewer preview or on cached data. */}
          {hideStatus ? null : <ScreenHeaderStatus />}
          {search ? (
            <Pressable
              onPressIn={() => setSearchPressed(true)}
              onPressOut={() => setSearchPressed(false)}
              onPress={search}
              accessibilityRole="button"
              accessibilityLabel="Search"
              hitSlop={8}
              android_ripple={{ color: t.borderSubtle, borderless: false }}
              // Static object for NativeWind v4; press state changes paint,
              // never geometry.
              style={{
                width: 44,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                overflow: "hidden",
                backgroundColor: searchPressed
                  ? t.accentSubtle
                  : "transparent",
              }}
            >
              <TabBarIcon name="search" color={t.fgMuted} size={20} />
            </Pressable>
          ) : null}
          {right}
        </View>
      ) : null}
    </View>
  );
}

function Chevron({ color }: { color: string }) {
  // Inline SVG-style chevron drawn with two rotated borders so we don't
  // need react-native-svg in this primitive. ~20×20.
  //
  // RTL. This is the app's ONLY back glyph — every screen with a back button
  // draws it — and it was pinned to `-45deg`, which points left in every
  // locale. Under an RTL layout the header mirrors (the button moves to the
  // right edge) while the arrow kept pointing away from where "back" now is.
  // `I18nManager.isRTL` is the platform's own answer and needs no new
  // dependency; the borders swap sides with the rotation so the corner drawn
  // is the leading one either way.
  const rtl = I18nManager.isRTL;
  return (
    <View
      style={{
        width: 20,
        height: 20,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 9,
          height: 9,
          ...(rtl
            ? { borderRightWidth: 2, borderTopWidth: 2, marginRight: 4 }
            : { borderLeftWidth: 2, borderTopWidth: 2, marginLeft: 4 }),
          borderColor: color,
          transform: [{ rotate: rtl ? "45deg" : "-45deg" }],
        }}
      />
    </View>
  );
}
