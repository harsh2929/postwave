/**
 * SegmentedControl — the app's switch between mutually exclusive views
 * (sort order, status filter, time range).
 *
 * Screens were expressing this as a row of ad-hoc `Pressable` chips, each with
 * its own selected-state styling. Two problems that a shared control fixes:
 *
 *  1. SELECTION WAS COLOUR-ONLY. A chip that differs from its neighbours only
 *     by background colour is invisible to a colour-blind user and, more
 *     importantly, to VoiceOver — nothing in the accessibility tree said which
 *     one was active. Here every option carries
 *     `accessibilityState={{ selected }}`, so assistive tech announces
 *     "Newest, selected" and the choice is real, not decorative.
 *
 *     THE SECOND HALF OF THAT, ADDED LATER: announcing the SELECTION is not
 *     the same as announcing that the chip can be TAPPED. Every option
 *     declared `accessibilityRole="tab"`, and React Native's own iOS trait
 *     table maps that word to nothing at all —
 *     `React/Views/RCTViewManager.m: @"tab" : @(UIAccessibilityTraitNone)`.
 *     So on iOS the chips carried no button trait, VoiceOver called them
 *     "GenericElement" with traits ["None"], and it never told anyone they
 *     were actionable. Confirmed on device against the dashboard's 7d/30d/90d
 *     row. `optionRole` below is the fix, and because it lives in this one
 *     shared control it repairs the ten-plus screens that use it at once.
 *  2. IT DIDN'T SCALE. Four filters fit; seven overflowed off-screen with no
 *     way to reach the rest. `scrollable` renders the same control in a
 *     horizontal scroller with the selected option auto-revealed.
 *
 * THE SELECTION INDICATOR TRAVELS. This header claimed it did long before it
 * was true: the selected chip simply repainted, so a tap swapped two static
 * blocks and nothing connected the option you left to the option you chose.
 * A single indicator now slides between measured positions using the shared
 * `move` intent, and every chip paints transparent behind it.
 *
 * TWO DETAILS THAT MATTER:
 *  - IT PAINTS THE CHIP UNTIL IT HAS MEASURED. Layout arrives one frame after
 *    the first render, so before then the selected chip keeps its own
 *    background — otherwise the control flashes with no selection at all on
 *    mount, which is worse than the problem being fixed.
 *  - REDUCE MOTION MOVES IT INSTANTLY, it does not remove it. The indicator IS
 *    the selection; hiding it would remove information, so the setting shortens
 *    the travel to zero and the position still updates.
 */
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { MIN_TOUCH_TARGET } from "@/lib/displayPreferences";
import { timing, useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /**
   * Optional trailing count, e.g. a filter's match count. Spoken with the
   * label by default ("Failing, 3"); see `accessibilityLabel`.
   */
  badge?: number | undefined;
  /**
   * What assistive tech announces instead of the default name. The default is
   * `label`, or "label, badge" when a `badge` is set, because this label
   * replaces the chip's children for a screen reader and a count left out of
   * it is a number only sighted users receive. Override it only to say what
   * the number counts ("Promotional, 7 designs").
   */
  accessibilityLabel?: string | undefined;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Group label for assistive tech, e.g. "Sort order". */
  accessibilityLabel?: string;
  /** Horizontal scroller for more options than fit on screen. */
  scrollable?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  scrollable = false,
}: SegmentedControlProps<T>) {
  const { t } = useTheme();
  const { reduceMotion } = useMotion();
  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef<Record<string, number>>({});
  const widths = useRef<Record<string, number>>({});
  // Shared values drive the indicator on the UI thread; `measured` is React
  // state because it changes which BRANCH renders (chip-painted vs
  // indicator-painted), and a shared value cannot trigger that.
  const indicatorX = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  const [measured, setMeasured] = useState(false);
  // Pressable's callback-style `style` is not used here: NativeWind's JSX
  // runtime drops layout for that form. A tiny piece of state keeps the style
  // object static while still giving iOS the same tactile visual feedback that
  // Android receives from its ripple.
  const [pressedValue, setPressedValue] = useState<T | null>(null);

  // Keep the active option reachable: when selection changes programmatically
  // (a deep link, a reset) the chosen chip may be scrolled off-screen.
  useEffect(() => {
    if (!scrollable) return;
    const x = offsets.current[value];
    if (typeof x === "number") {
      scrollRef.current?.scrollTo({ x: Math.max(0, x - 24), animated: true });
    }
  }, [value, scrollable]);

  // Move the indicator whenever the selection changes. `measured` is a
  // dependency so the very first placement (which happens one frame after
  // mount, once onLayout has reported) is applied too.
  //
  // THE FIRST PLACEMENT IS A JUMP, NOT A TRAVEL. The shared values start at 0,
  // so animating that first assignment would slide the indicator in from the
  // left edge of the control on every mount — a screen-load animation nobody
  // asked for, and a wrong one: nothing moved, the control simply appeared.
  // Only a real selection CHANGE travels.
  const placed = useRef(false);
  useEffect(() => {
    const x = offsets.current[value];
    const width = widths.current[value];
    if (typeof x !== "number" || typeof width !== "number") return;
    if (placed.current) {
      indicatorX.value = timing(x, "move", reduceMotion);
      indicatorWidth.value = timing(width, "move", reduceMotion);
    } else {
      placed.current = true;
      indicatorX.value = x;
      indicatorWidth.value = width;
    }
  }, [value, measured, reduceMotion, indicatorX, indicatorWidth]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
    width: indicatorWidth.value,
  }));

  // WHY THE ROLE DIFFERS BY PLATFORM. On Android `tab` is real: it maps to a
  // TabWidget class name and TalkBack announces "tab, 2 of 3", which is the
  // most accurate description of what these chips are. On iOS the same word
  // maps to `UIAccessibilityTraitNone`, so it describes nothing and — worse —
  // costs the chip the button trait it would otherwise have had. `button` is
  // the closest iOS trait that is TRUE (it is tappable and it acts on tap),
  // and it is what UIKit's own segmented control exposes for its segments.
  //
  // Read at RENDER time rather than module scope so the choice is observable
  // per platform in a test, and so a `Platform.OS` swap can never be baked in
  // at import.
  const optionRole = Platform.OS === "ios" ? "button" : "tab";

  const items = options.map((option) => {
    const selected = option.value === value;
    const pressed = option.value === pressedValue;
    return (
      <Pressable
        key={option.value}
        onPressIn={() => setPressedValue(option.value)}
        onPressOut={() =>
          setPressedValue((current) =>
            current === option.value ? null : current,
          )
        }
        onPress={() => {
          if (selected) return;
          haptics.tap();
          onChange(option.value);
        }}
        onLayout={(event) => {
          const { x, width } = event.nativeEvent.layout;
          offsets.current[option.value] = x;
          widths.current[option.value] = width;
          // Flip to indicator-painted once the SELECTED option has a real
          // width. Guarding on width > 0 matters: a control mounted inside a
          // collapsed sheet reports 0 and would otherwise leave a zero-width
          // indicator standing in for the selection.
          if (option.value === value && width > 0 && !measured) {
            setMeasured(true);
          }
        }}
        // `optionRole`, not the literal "tab": see the note above it. The
        // selection is announced by `accessibilityState` either way, so the
        // role only has to carry "you can press this".
        accessibilityRole={optionRole}
        // An accessibilityLabel on the Pressable REPLACES its children for
        // assistive tech, so the `badge` numeral is never read on its own.
        // The default therefore carries it ("Failing, 3"): without that, the
        // count was silently unavailable on every screen that did not pass a
        // label. `typeof`, not truthiness, so a visible 0 is spoken as 0. A
        // caller's `option.accessibilityLabel` still wins, for naming what the
        // number counts ("Promotional, 7 designs").
        accessibilityLabel={
          option.accessibilityLabel ??
          (typeof option.badge === "number"
            ? `${option.label}, ${option.badge}`
            : option.label)
        }
        // The part that makes selection real rather than visual.
        accessibilityState={{ selected }}
        android_ripple={{ color: t.borderSubtle, borderless: false }}
        style={{
          flexGrow: scrollable ? 0 : 1,
          // This control is used for the sign-in method as well as dense list
          // filters. Both are controls, so every segment owns a full iOS
          // 44pt target rather than asking hitSlop to cover a 36pt visual.
          minHeight: MIN_TOUCH_TARGET,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 6,
          paddingHorizontal: 14,
          borderRadius: 9,
          // Once the indicator is live it owns the selected fill; until then
          // the chip paints itself so the control is never briefly selection-
          // less. The border stays on the chip in both cases — it is the
          // non-colour cue, and it must not depend on an animation landing.
          backgroundColor: pressed
            ? t.accentSubtle
            : selected && !measured
              ? t.surfaceElevated
              : "transparent",
          // A 1px border on the selected chip gives a second, non-colour cue.
          borderWidth: 1,
          borderColor: selected ? t.border : "transparent",
        }}
      >
        {/* Dense: the segments share one row under a `numberOfLines={1}`, so
            the label cannot reflow and takes the dense ceiling. Was 13.5 — a
            half-pixel size nobody chose. */}
        <Text
          numberOfLines={1}
          {...typeCap("control")}
          style={{
            color: selected ? t.fg : t.fgMuted,
            fontFamily: selected ? FONT.semibold : FONT.regular,
            ...typeStyle("control"),
          }}
        >
          {option.label}
        </Text>
        {typeof option.badge === "number" ? (
          <View
            style={{
              minWidth: 18,
              paddingHorizontal: 5,
              paddingVertical: 1,
              borderRadius: 9,
              backgroundColor: selected ? t.accent : t.bgSubtle,
              alignItems: "center",
            }}
          >
            <Text
              {...typeCap("badgeSmall")}
              style={{
                color: selected ? t.accentFg : t.fgMuted,
                fontFamily: FONT.medium,
                ...typeStyle("badgeSmall"),
              }}
            >
              {option.badge}
            </Text>
          </View>
        ) : null}
      </Pressable>
    );
  });

  const shell = {
    flexDirection: "row" as const,
    backgroundColor: t.bgSubtle,
    borderRadius: 11,
    padding: 3,
    gap: 3,
  };

  // Behind the chips, inside the padded shell. `translateX` rather than `left`
  // so the travel runs on the UI thread and stays smooth while the list under
  // the control is re-rendering with its new filter.
  const indicator = measured ? (
    <Animated.View
      pointerEvents="none"
      // Decoration only — the selection is announced by each option's
      // accessibilityState, so this must not appear in the reading order.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          position: "absolute" as const,
          top: 3,
          bottom: 3,
          // DELIBERATELY PHYSICAL. `onLayout` reports `x` in the parent's
          // physical coordinate space and `translateX` moves in that same
          // space, so the origin has to be physical too. A logical
          // `insetInlineStart` would flip the origin to the trailing edge on
          // an RTL locale while the translation kept measuring from the left,
          // and the indicator would land on the wrong chip.
          left: 0,
          borderRadius: 9,
          backgroundColor: t.surfaceElevated,
        },
        indicatorStyle,
      ]}
    />
  ) : null;

  if (scrollable) {
    return (
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        {...(accessibilityLabel ? { accessibilityLabel } : {})}
        contentContainerStyle={shell}
      >
        {indicator}
        {items}
      </ScrollView>
    );
  }

  return (
    <View
      accessibilityRole="tablist"
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      style={shell}
    >
      {indicator}
      {items}
    </View>
  );
}
