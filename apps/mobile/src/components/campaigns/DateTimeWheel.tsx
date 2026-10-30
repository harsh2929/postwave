/**
 * DateTimeWheel — the schedule sheet's date / hour / minute picker.
 *
 * Lifted out of CampaignDetailControls when it stopped being three arrays and
 * a ScrollView. What changed, and why each mattered:
 *
 *  - IT SHOWS WHAT IS CURRENTLY SET. The columns were plain ScrollViews with
 *    no contentOffset, so opening the sheet on a campaign scheduled for 22:00
 *    put hour 00 at the top with the selection off-screen — the picker opened
 *    claiming a value it was not showing. Every column now scrolls its
 *    selection to the centre on mount and whenever the sheet re-opens.
 *  - IT CAN EXPRESS ANY DATE THE CAMPAIGN ALREADY HAS. See wheelDateOptions:
 *    the 31-day window silently rewrote a campaign scheduled further out.
 *  - IT PRESERVES AN OFF-GRID MINUTE (wheelMinuteOptions), instead of rounding
 *    09:07 down to 09:05 on open and writing that back on Save.
 *  - IT GROWS WITH THE OS TEXT SIZE. The container was `height: 200`, so at
 *    accessibility text sizes the 44pt rows grew inside a box that did not.
 *
 * The option maths is pure and tested in src/lib/dateWheel.ts; this file is
 * the rendering and the scroll effect.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";

import {
  dateWheelHeight,
  startOfDay,
  wheelDateOptions,
  wheelMinuteOptions,
  wheelScrollOffset,
} from "@/lib/dateWheel";
import { FONT } from "@/lib/fonts";
import { calendarDate } from "@/lib/format";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Fallback row height until the first row reports its real one. */
const ESTIMATED_ROW_HEIGHT = 46;

export interface DateTimeWheelProps {
  value: Date;
  onChange: (next: Date) => void;
  t: ThemeTokens;
  /**
   * Changes whenever the picker becomes visible again. The wheel re-centres on
   * its selection each time this changes, which is what makes re-opening the
   * sheet show the value it is holding rather than the top of each column.
   */
  focusKey?: string | number | undefined;
}

export function DateTimeWheel({
  value,
  onChange,
  t,
  focusKey,
}: DateTimeWheelProps) {
  const { fontScale } = useWindowDimensions();
  const height = dateWheelHeight(fontScale);

  // `today` is captured once per mount: recomputing it every render would
  // rebuild 180 Date objects on each keystroke elsewhere in the sheet.
  const today = useMemo<Date>(() => startOfDay(new Date()), []);

  const selectedDateKey = startOfDay(value).getTime();
  const selectedHour = value.getHours();
  // The EXACT minute — no rounding onto the 5-minute grid.
  const selectedMinute = value.getMinutes();

  const dateOptions = useMemo<Date[]>(
    () => wheelDateOptions(today, value),
    [today, value],
  );
  const hourOptions = useMemo<number[]>(
    () => Array.from({ length: 24 }, (_, i) => i),
    [],
  );
  const minuteOptions = useMemo<number[]>(
    () => wheelMinuteOptions(selectedMinute),
    [selectedMinute],
  );

  const setDay = (d: Date): void => {
    const next = new Date(value);
    next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    next.setSeconds(0, 0);
    onChange(next);
  };
  const setHour = (h: number): void => {
    const next = new Date(value);
    next.setHours(h);
    next.setSeconds(0, 0);
    onChange(next);
  };
  const setMinute = (m: number): void => {
    const next = new Date(value);
    next.setMinutes(m, 0, 0);
    onChange(next);
  };

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 8,
        flexDirection: "row",
        gap: 8,
        height,
      }}
      accessibilityLabel="Date and time picker"
      accessibilityHint="Choose the send date, hour, and minute."
    >
      <WheelColumn
        accessibilityLabel="Send date"
        items={dateOptions.map((d) => ({
          key: String(startOfDay(d).getTime()),
          label: formatDateOption(d, today),
          isSelected: startOfDay(d).getTime() === selectedDateKey,
          onPress: () => setDay(d),
        }))}
        flex={2}
        t={t}
        viewportHeight={height - 16}
        focusKey={focusKey}
      />
      <WheelColumn
        accessibilityLabel="Send hour"
        items={hourOptions.map((h) => ({
          key: `h-${h}`,
          label: String(h).padStart(2, "0"),
          isSelected: h === selectedHour,
          onPress: () => setHour(h),
        }))}
        flex={1}
        t={t}
        viewportHeight={height - 16}
        focusKey={focusKey}
      />
      <WheelColumn
        accessibilityLabel="Send minute"
        items={minuteOptions.map((m) => ({
          key: `m-${m}`,
          label: String(m).padStart(2, "0"),
          isSelected: m === selectedMinute,
          onPress: () => setMinute(m),
        }))}
        flex={1}
        t={t}
        viewportHeight={height - 16}
        focusKey={focusKey}
      />
    </View>
  );
}

interface WheelItem {
  key: string;
  label: string;
  isSelected: boolean;
  onPress: () => void;
}

function WheelColumn({
  accessibilityLabel,
  items,
  flex,
  t,
  viewportHeight,
  focusKey,
}: {
  accessibilityLabel: string;
  items: WheelItem[];
  flex: number;
  t: ThemeTokens;
  viewportHeight: number;
  focusKey: string | number | undefined;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const rowHeight = useRef(ESTIMATED_ROW_HEIGHT);

  const selectedIndex = items.findIndex((it) => it.isSelected);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : items[0];
  const itemCount = items.length;

  // Centre the selection on mount, whenever the sheet re-opens, and whenever
  // the selection moves far enough that it could have left the viewport (e.g.
  // "Use this time" jumping the hour column by 14 rows).
  useEffect(() => {
    if (selectedIndex < 0) return;
    const offset = wheelScrollOffset(
      selectedIndex,
      rowHeight.current,
      viewportHeight,
      itemCount,
    );
    // `animated: false` — this is a restore of existing state, not a
    // transition the user initiated, and animating it reads as drift.
    scrollRef.current?.scrollTo({ y: offset, animated: false });
  }, [selectedIndex, itemCount, viewportHeight, focusKey]);

  const measureRow = (event: LayoutChangeEvent): void => {
    const measured = event.nativeEvent.layout.height;
    if (measured > 0) rowHeight.current = measured + 2; // + marginVertical
  };

  const moveSelection = (delta: number): void => {
    const base = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = Math.max(0, Math.min(items.length - 1, base + delta));
    items[nextIndex]?.onPress();
  };

  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex, backgroundColor: t.bgSubtle, borderRadius: 8 }}
      nestedScrollEnabled
      contentContainerStyle={{ paddingVertical: 4 }}
      showsVerticalScrollIndicator={false}
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Swipe up or down to adjust. Double tap an option to select it."
      accessibilityValue={{ text: selectedItem?.label ?? "" }}
      accessibilityActions={[
        { name: "increment", label: "Next" },
        { name: "decrement", label: "Previous" },
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "increment") {
          moveSelection(1);
        } else if (event.nativeEvent.actionName === "decrement") {
          moveSelection(-1);
        }
      }}
    >
      {items.map((it, index) => (
        <Pressable
          key={it.key}
          onPress={it.onPress}
          onLayout={index === 0 ? measureRow : undefined}
          accessibilityRole="button"
          accessibilityLabel={it.label}
          accessibilityState={{ selected: it.isSelected }}
          accessibilityHint={`Set ${accessibilityLabel.toLowerCase()} to ${it.label}.`}
          style={{
            backgroundColor: it.isSelected ? t.accent : "transparent",
            paddingVertical: 8,
            paddingHorizontal: 8,
            minHeight: 44,
            borderRadius: 6,
            marginVertical: 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            // A wheel row is dense geometry inside a bounded column: capped so
            // the rows stay tappable, while the column itself grows (see
            // dateWheelHeight) so they are not clipped.
            {...typeCap("numeric")}
            style={{
              color: it.isSelected ? t.accentFg : t.fg,
              ...typeStyle("numeric"),
              fontSize: 14,
              fontWeight: it.isSelected ? "700" : "500",
              fontFamily: it.isSelected ? FONT.bold : FONT.medium,
              fontVariant: ["tabular-nums"],
            }}
          >
            {it.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function formatDateOption(d: Date, today: Date): string {
  const same = d.getTime() === today.getTime();
  if (same) return "Today";
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.getTime() === tomorrow.getTime()) return "Tomorrow";
  // A six-month window crosses a year boundary; "Mon, Jan 5" without a year
  // is ambiguous the moment the list runs past December.
  return calendarDate(d, {
    weekday: "short",
    withYear: d.getFullYear() !== today.getFullYear(),
  });
}
