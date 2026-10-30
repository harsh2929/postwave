/**
 * SubscriberRow — one row of the subscribers list.
 *
 * Extracted from app/(tabs)/subscribers/index.tsx so it can be `memo()`'d (the
 * screen re-renders on every keystroke of the debounced search) and so the
 * screen stays inside its size budget.
 *
 * What it now shows that the old inline row did not:
 *   - the person's NAME, with the email demoted to a muted second line.
 *     first_name / last_name / full_name / display_name all arrive on the
 *     same payload and were being discarded at the type boundary.
 *   - a coloured initial, so a scrolling list has a visual anchor.
 *   - a HUMAN status label ("Unsubscribed"), not the Postgres enum
 *     ("blocklisted").
 *   - an engagement signal, when the server sent one.
 *
 * Swipe actions are published as accessibilityActions by SwipeableRow, so
 * the gesture is never the only path to them.
 *
 * SELECTION MODE changes the row's whole gesture contract, so it is modelled
 * explicitly rather than bolted on:
 *   - a long press ENTERS selection mode (and selects this row);
 *   - while selecting, a tap TOGGLES rather than navigates, the swipe actions
 *     are withdrawn (a swipe that suppressed a row mid-multi-select would be
 *     an unrecoverable surprise), and the row reports
 *     accessibilityRole="checkbox" with a real checked state;
 *   - rows the server sent WITHOUT an id are not selectable at all — the bulk
 *     endpoints take ids, so a row that cannot contribute one must not appear
 *     to participate.
 *
 * The 64pt `minHeight` is DECLARED rather than inherited from whatever the
 * current font sizes happen to produce: at the smallest Dynamic Type setting a
 * single-line row with no pills was drifting under the 44pt floor.
 */
import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { Link } from "expo-router";

import { Pill } from "@/components/Pill";
import { SwipeableRow, type SwipeAction } from "@/components/SwipeableRow";
import { Avatar } from "@/components/subscriber/Avatar";
import { useDensityMetrics } from "@/hooks/useRowDensity";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import {
  subscriberPrimaryLabel,
  subscriberSecondaryLabel,
} from "@/lib/subscriberIdentity";
import {
  subscriberStatusLabel,
  subscriberStatusTone,
} from "@/lib/subscriberStatus";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SubscriberListRow {
  id?: string;
  email: string;
  status?: string;
  tags?: string[];
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  display_name?: string | null;
  /** Server-side pointers: absent means "not scored", never zero. */
  engagement_score?: number | null;
  churn_score?: number | null;
  /** Mailchimp-parity contact rating, 1..5 stars. Absent = unrated. */
  rating?: number | null;
  /**
   * AUDIENCE#56 — SUB-009 soft delete. Present only when the list was fetched
   * with `?include_archived=true`; a row carrying it is HIDDEN from campaigns
   * and must say so, because otherwise the "show archived" view is
   * indistinguishable from the default one.
   */
  archived_at?: string | null;
}

/** Above this the churn signal is worth the pixels it costs on a phone. */
const CHURN_RISK_THRESHOLD = 70;

/** Rating is 1..5 server-side (migration 0226); anything else is not a
 *  rating and must not render as one. */
function ratingStars(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const stars = Math.round(value);
  return stars >= 1 && stars <= 5 ? stars : null;
}

function engagementTone(score: number): "success" | "warning" | "neutral" {
  if (score >= 60) return "success";
  if (score >= 25) return "neutral";
  return "warning";
}

function SubscriberRowBody({
  item,
  onSuppress,
  selecting = false,
  selected = false,
  onToggleSelect,
  onBeginSelect,
}: {
  item: SubscriberListRow;
  /**
   * Omit (or pass undefined) to disable row actions — offline, read-only,
   * or a row the server sent without an id. Taking a stable callback rather
   * than a freshly-built action array is what lets `memo` actually hold.
   */
  onSuppress?: ((item: SubscriberListRow) => void) | undefined;
  /** The list is in multi-select mode. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: ((id: string) => void) | undefined;
  /** Long press. Omit to leave the row's long press unbound. */
  onBeginSelect?: ((id: string) => void) | undefined;
}) {
  const { t } = useTheme();
  const density = useDensityMetrics();
  const selectable = Boolean(item.id) && Boolean(onToggleSelect);
  const actions: readonly SwipeAction[] = useMemo(
    () =>
      // Withdrawn during selection: see the module doc.
      onSuppress && item.id && !selecting
        ? [
            {
              label: "Suppress",
              kind: "danger",
              onPress: () => onSuppress(item),
            },
          ]
        : [],
    [item, onSuppress, selecting],
  );
  const primary = subscriberPrimaryLabel(item);
  const secondary = subscriberSecondaryLabel(item);
  const statusLabel = subscriberStatusLabel(item.status);
  const engagement =
    typeof item.engagement_score === "number" &&
    Number.isFinite(item.engagement_score)
      ? Math.round(item.engagement_score)
      : null;
  const churn =
    typeof item.churn_score === "number" && Number.isFinite(item.churn_score)
      ? Math.round(item.churn_score)
      : null;
  const stars = ratingStars(item.rating);
  const archived = Boolean(item.archived_at);

  const spoken = [
    primary,
    secondary,
    // Leads the signal list: it changes what every other signal MEANS.
    archived ? "archived" : "",
    statusLabel,
    engagement == null ? "" : `engagement ${num(engagement)} out of 100`,
    churn != null && churn >= CHURN_RISK_THRESHOLD ? "at risk of churn" : "",
    stars == null ? "" : `rated ${stars} out of 5`,
  ]
    .filter(Boolean)
    .join(", ");

  const rowStyle = {
    backgroundColor: selected ? t.bgSubtle : t.surface,
    borderColor: selected ? t.accent : t.borderSubtle,
    borderWidth: selected ? 2 : 1,
    borderRadius: 14,
    // Padding compensates for the thicker selected border so the row's outer
    // box is identical in both states, and comes from the user's density
    // preference (LOVE#51). Compact removes AIR, never type size — the type
    // scale is the Dynamic Type contract and is untouched here.
    padding: selected ? density.rowPadding - 1 : density.rowPadding,
    // Declared floor, not an incidental one — see the module doc. Both density
    // values are asserted to stay at or above the 44pt touch target in
    // lib/displayPreferences.test.ts.
    minHeight: density.rowMinHeight,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: density.rowGap,
  };

  const body = (
    <>
      {selecting ? (
        <SelectionMark selected={selected} disabled={!selectable} t={t} />
      ) : null}
      <Avatar subscriber={item} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
              numberOfLines={1}
            >
              {primary}
            </Text>
            {secondary ? (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  marginTop: 1,
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
              >
                {secondary}
              </Text>
            ) : null}
            <SignalRow
              archived={archived}
              statusLabel={statusLabel}
              statusTone={subscriberStatusTone(item.status)}
              engagement={engagement}
              churn={churn}
              stars={stars}
              tags={item.tags}
              t={t}
            />
          </View>
    </>
  );

  // SELECTION MODE: a tap toggles, so the row must not be a navigation
  // target at all. Rendering the Link and merely ignoring its press would
  // still hand VoiceOver "Open …, link".
  if (selecting) {
    return (
      <Pressable
        onPress={() => {
          if (selectable && item.id) onToggleSelect?.(item.id);
        }}
        disabled={!selectable}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected, disabled: !selectable }}
        accessibilityLabel={spoken}
        accessibilityHint={
          selectable
            ? "Double tap to add or remove this subscriber from the selection"
            : "This row can't be selected — the server sent it without an id"
        }
        style={{ ...rowStyle, opacity: selectable ? 1 : 0.5 }}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <SwipeableRow right={actions} accessibilityLabel={spoken}>
      <Link
        href={{
          pathname: "/(tabs)/subscribers/[id]",
          params: { id: item.id ?? item.email },
        }}
        asChild
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${spoken}`}
          {...(selectable
            ? {
                accessibilityHint: "Long press to start selecting subscribers",
                onLongPress: () => onBeginSelect?.(item.id as string),
                delayLongPress: 300,
              }
            : {})}
          // NativeWind v4: a function-style `style` on Pressable silently
          // drops layout. Static object only.
          style={rowStyle}
        >
          {body}
        </Pressable>
      </Link>
    </SwipeableRow>
  );
}

/**
 * The row's badge strip: status, engagement, churn risk, rating, tags.
 *
 * Extracted so SubscriberRowBody stays inside its complexity budget once the
 * selection-mode branch landed. Every branch here is "render this signal only
 * when the server actually sent it" — an absent score is an absent badge, never
 * a zero.
 */
function SignalRow({
  archived,
  statusLabel,
  statusTone,
  engagement,
  churn,
  stars,
  tags,
  t,
}: {
  archived: boolean;
  statusLabel: string;
  statusTone: ReturnType<typeof subscriberStatusTone>;
  engagement: number | null;
  churn: number | null;
  stars: number | null;
  tags: string[] | undefined;
  t: ReturnType<typeof useTheme>["t"];
}) {
  const badgeStyle = {
    color: t.fgMuted,
    ...typeStyle("badgeSmall"),
    fontFamily: FONT.regular,
  };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginTop: 8,
        gap: 6,
        flexWrap: "wrap",
      }}
    >
      {/* First, and a WORD rather than a dimmed row: an archived contact is
          hidden from every send, which outranks its consent status. */}
      {archived ? <Pill label="Archived" tone="warning" /> : null}
      <Pill label={statusLabel} tone={statusTone} />
      {engagement == null ? null : (
        <Pill label={`${num(engagement)} eng`} tone={engagementTone(engagement)} />
      )}
      {churn != null && churn >= CHURN_RISK_THRESHOLD ? (
        <Pill label="At risk" tone="danger" />
      ) : null}
      {stars == null ? null : (
        <Text
          // `badgeSmall`: the stars sit in the same wrap row as the status
          // pills and must grow at the same rate they do, or the row's
          // baselines drift apart at a large text setting.
          {...typeCap("badgeSmall")}
          style={badgeStyle}
          // The glyphs are decoration; the exact value is spoken by the row's
          // own label, so this node stays silent.
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          {"\u2605".repeat(stars)}
        </Text>
      )}
      {tags && tags.length > 0 ? (
        <Text
          {...typeCap("badgeSmall")}
          style={{ ...badgeStyle, flexShrink: 1 }}
          numberOfLines={1}
        >
          {tags.slice(0, 3).join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The checkbox drawn beside a row in selection mode. It is decoration: the
 * row itself carries accessibilityRole="checkbox" and the checked state, so
 * this node must stay silent or VoiceOver reads the state twice.
 *
 * Shape as well as fill carries the state — a filled circle with a tick
 * versus an empty ring — so selection is never colour-alone.
 */
function SelectionMark({
  selected,
  disabled,
  t,
}: {
  selected: boolean;
  disabled: boolean;
  t: ReturnType<typeof useTheme>["t"];
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: disabled ? t.borderSubtle : selected ? t.accent : t.border,
        backgroundColor: selected ? t.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {selected ? (
        <Text
          allowFontScaling={false}
          style={{ color: t.bg, fontFamily: FONT.bold, fontSize: 13, lineHeight: 16 }}
        >
          ✓
        </Text>
      ) : null}
    </View>
  );
}

export const SubscriberRow = memo(SubscriberRowBody);
