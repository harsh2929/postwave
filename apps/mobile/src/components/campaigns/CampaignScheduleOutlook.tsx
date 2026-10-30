/**
 * CampaignScheduleOutlook — the month-at-a-glance density grid over the
 * scheduled agenda.
 *
 * Renders only while the Scheduled bucket is active (the screen mounts it
 * beside the agenda), collapsed to one toggle row by default: a six-week grid
 * is tall, and the agenda — "what is next?" — remains the primary answer.
 * Opened, it shows the anchor month with a per-day count of scheduled sends;
 * tapping a day with sends narrows the agenda underneath to that day, tapping
 * it again widens back out. Month paging and "Today" mirror desktop's
 * CampaignCalendar navigation.
 *
 * WHY THERE IS NO DRAG-TO-RESCHEDULE HERE: desktop's own drag is dead behind
 * `CAMPAIGN_SCHEDULING_AVAILABLE = false`, and mobile's live reschedule is
 * CampaignScheduleModal on the campaign detail screen — one tap from any
 * agenda row this grid narrows to. The grid is a lens, not an editor.
 *
 * All month arithmetic lives in lib/campaignCalendarMonth (node-tested); this
 * file is only the rendering half. NativeWind v4 gotcha: static Pressable
 * style objects only.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { type AgendaRow } from "@/lib/campaignAgenda";
import {
  addMonths,
  buildCampaignMonth,
  monthAnchor,
  type MonthCell,
} from "@/lib/campaignCalendarMonth";
import { forwardChevron } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { calendarDate, monthYear, plural } from "@/lib/format";
import { useMotion } from "@/lib/motion";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(dayStart: number): string {
  return calendarDate(dayStart, { weekday: "long" });
}

function DayCell({
  cell,
  selected,
  onPress,
  t,
}: {
  cell: MonthCell;
  selected: boolean;
  /** Undefined for a day with nothing on it — no affordance, not a dead tap. */
  onPress: (() => void) | undefined;
  t: ThemeTokens;
}) {
  const label =
    cell.count > 0
      ? `${dayLabel(cell.dayStart)}, ${plural(cell.count, "scheduled send")}`
      : `${dayLabel(cell.dayStart)}, nothing scheduled`;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !onPress }}
      {...(onPress
        ? {
            accessibilityHint: selected
              ? "Shows the whole schedule again."
              : "Narrows the schedule below to this day.",
          }
        : {})}
      style={{
        flex: 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected
          ? t.accent
          : cell.today
            ? t.border
            : "transparent",
        backgroundColor: selected ? t.accent : "transparent",
        opacity: cell.inMonth ? 1 : 0.35,
        paddingVertical: 4,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: selected ? t.accentFg : cell.today ? t.fg : t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: cell.today ? FONT.semibold : FONT.regular,
        }}
      >
        {new Date(cell.dayStart).getDate()}
      </Text>
      {cell.count > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: selected ? t.accentFg : t.accent,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
          }}
        >
          {cell.count}
        </Text>
      ) : null}
    </Pressable>
  );
}

function NavButton({
  glyph,
  label,
  onPress,
  t,
  mirrored = false,
}: {
  glyph: string;
  label: string;
  onPress: () => void;
  t: ThemeTokens;
  /**
   * Draw the glyph flipped across the vertical axis. A chevron is the ONE
   * shape here that carries reading direction, and `lib/direction` only names
   * the FORWARD one; "previous" is its mirror image in either layout
   * direction, so mirroring the forward chevron keeps the pair correct under
   * RTL without a second literal glyph that would point the wrong way.
   */
  mirrored?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={{
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
          ...(mirrored ? { transform: [{ scaleX: -1 }] } : {}),
        }}
      >
        {glyph}
      </Text>
    </Pressable>
  );
}

export function CampaignScheduleOutlook({
  rows,
  selectedDay,
  onSelectDay,
}: {
  /** The filtered, sorted list the agenda itself renders from. */
  rows: readonly AgendaRow[];
  /** Local midnight of the day the agenda is narrowed to, or null. */
  selectedDay: number | null;
  onSelectDay: (dayStart: number | null) => void;
}) {
  const { t } = useTheme();
  const { animateLayout } = useMotion();
  const [open, setOpen] = useState(false);
  const [anchorMs, setAnchorMs] = useState(() => monthAnchor(Date.now()));

  const month = useMemo(
    () => buildCampaignMonth(rows, anchorMs, Date.now()),
    [rows, anchorMs],
  );
  const monthLabel = monthYear(anchorMs);
  const weeks = useMemo(() => {
    const out: MonthCell[][] = [];
    for (let i = 0; i < month.cells.length; i += 7) {
      out.push(month.cells.slice(i, i + 7));
    }
    return out;
  }, [month]);

  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
      <Pressable
        onPress={() => {
          haptics.tap();
          animateLayout("enter");
          setOpen((prev) => !prev);
        }}
        accessibilityRole="button"
        accessibilityLabel={open ? "Hide the month view" : "Show the month view"}
        accessibilityState={{ expanded: open }}
        style={{
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.accent,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          {open ? "Hide month view" : "Month view"}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {open ? "" : "— the send calendar at a glance"}
        </Text>
      </Pressable>

      {open ? (
        <View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <NavButton
              glyph={forwardChevron()}
              mirrored
              label="Previous month"
              onPress={() => setAnchorMs((prev) => addMonths(prev, -1))}
              t={t}
            />
            <Text
              {...typeCap("callout")}
              accessibilityLiveRegion="polite"
              style={{
                color: t.fg,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
                flex: 1,
                textAlign: "center",
              }}
            >
              {monthLabel}
            </Text>
            <NavButton
              glyph={forwardChevron()}
              label="Next month"
              onPress={() => setAnchorMs((prev) => addMonths(prev, 1))}
              t={t}
            />
            <NavButton
              glyph="•"
              label="Back to the current month"
              onPress={() => setAnchorMs(monthAnchor(Date.now()))}
              t={t}
            />
          </View>

          <View style={{ flexDirection: "row" }}>
            {DOW.map((day) => (
              <Text
                key={day}
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  flex: 1,
                  textAlign: "center",
                }}
              >
                {day}
              </Text>
            ))}
          </View>

          {weeks.map((week) => (
            <View
              key={`week-${week[0]?.dayStart ?? 0}`}
              style={{ flexDirection: "row", gap: 2, marginTop: 2 }}
            >
              {week.map((cell) => (
                <DayCell
                  key={cell.dayStart}
                  cell={cell}
                  selected={selectedDay === cell.dayStart}
                  onPress={
                    cell.count > 0
                      ? () => {
                          haptics.tap();
                          animateLayout("enter");
                          onSelectDay(
                            selectedDay === cell.dayStart
                              ? null
                              : cell.dayStart,
                          );
                        }
                      : undefined
                  }
                  t={t}
                />
              ))}
            </View>
          ))}

          <Text
            {...typeCap("caption")}
            accessibilityLiveRegion="polite"
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
          >
            {selectedDay !== null
              ? `Showing ${dayLabel(selectedDay)} only — tap the day again for the whole schedule.`
              : month.scheduledInMonth > 0
                ? `${plural(month.scheduledInMonth, "send")} scheduled in ${monthLabel}. Days are counted from the loaded list, so scroll the agenda to load more if pages remain.`
                : `Nothing is scheduled in ${monthLabel}.`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
