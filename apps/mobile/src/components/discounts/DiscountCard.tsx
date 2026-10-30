/**
 * DiscountCard — one discount code in the list.
 *
 * Split out of `app/(tabs)/discounts.tsx` when the Dynamic Type pass pushed
 * that file past its source budget. The card answers the two questions the
 * screen exists for — is this code still working, and how much has it been
 * used — and defers the per-redemption audit to the drawer below it.
 *
 * THE SHARE AFFORDANCE IS ABSOLUTELY POSITIONED, so the card's own end padding
 * is the only thing keeping a long code from running under it. Both numbers
 * come from `shareSlotWidth`, which is derived from the `control` role's
 * ceiling — they used to be the independent literals 48 and 64, which are
 * correct at exactly one OS text size. They are `end` / `paddingEnd` rather
 * than `right` / `paddingRight` because RTL mirrors flex but NOT absolute
 * left/right (COMMERCE#64): under Arabic or Hebrew the hard-coded version put
 * the button on top of the code it was padding away from.
 *
 * SWIPE IS A SHORTCUT, NEVER THE ONLY PATH. The row's actions are also reachable
 * without the gesture — Share as the visible button, Extend inside the drawer —
 * and `SwipeableRow` republishes both as VoiceOver rotor actions, so adding the
 * gesture cannot subtract reachability.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { Pill } from "@/components/Pill";
import { SwipeableRow, type SwipeAction } from "@/components/SwipeableRow";
import {
  DiscountRedemptionsDrawer,
  type DiscountDrawerBinding,
} from "@/components/discounts/DiscountRedemptionsDrawer";
import {
  appliesLabel,
  redeemedCount,
  statusOf,
} from "@/components/discounts/discountStatus";
import type { DiscountRedemptionRow, DiscountRow } from "@/hooks/useDiscountOps";
import { formatDiscountOff } from "@/lib/discountFormat";
import { dateTime, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import * as haptics from "@/lib/haptics";
import { durationFor, useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface DiscountCardProps {
  row: DiscountRow;
  expanded: boolean;
  /**
   * Called with the row's ARCHIVE RECORD ID, not its code. The drawer's one
   * mounted route is `{record_id}`-addressed, and `id` is the only identifier
   * the archive projection still carries.
   */
  onToggle: (recordId: string) => void;
  onShare: (code: string) => void;
  /** The `useDiscountRedemptions` query; only read while `expanded`. */
  redemptions: {
    isFetching: boolean;
    isError: boolean;
    error: unknown;
    data: DiscountRedemptionRow[] | undefined;
    refetch: () => unknown;
  };
  /** Reserved width for the Share affordance, from `shareSlotWidth`. */
  shareSlot: number;
  fontScale: number;
  /** Drawer wiring; a frozen idle constant for every collapsed row. */
  binding: DiscountDrawerBinding;
  /**
   * The screen's minute-bucketed clock. Passed in rather than read from
   * `Date.now()` here because this component is memoised: an expiry crossed
   * while the screen sat open would otherwise never reach the pill, leaving it
   * green under a chip strip that had already counted the code as expired.
   */
  now: number;
}

function DiscountCardImpl({
  row,
  expanded,
  onToggle,
  onShare,
  redemptions,
  shareSlot,
  fontScale,
  binding,
  now,
}: DiscountCardProps) {
  const { t } = useTheme();
  // COMMERCE#53: the drawer used to be swapped into the tree instantly, so a
  // card could grow by half a screen with nothing connecting the tap to the
  // change — the one thing on this card that moved without saying it had.
  // A fade is deliberately modest: this is a disclosure inside a list, and a
  // height animation on a FlatList row fights the list's own layout.
  const { reduceMotion } = useMotion();
  const status = statusOf(row, now);
  const used = redeemedCount(row);
  const cap =
    row.max_redemptions !== null && row.max_redemptions !== undefined
      ? `${num(used)} / ${num(row.max_redemptions)}`
      : plural(used, "redemption");
  const applies = appliesLabel(row.applies_to);

  // Swipe actions. `onEdit` is null for a session whose role cannot PATCH, and
  // the action is then absent rather than present-and-failing. Memoised so the
  // array identity is stable across the polls of a neighbouring open drawer.
  const onEdit = binding.onEdit;
  const swipeActions = useMemo<SwipeAction[]>(() => {
    const actions: SwipeAction[] = [
      { label: "Share", kind: "neutral", onPress: () => onShare(row.code) },
    ];
    if (onEdit) {
      actions.push({
        label: "Extend",
        kind: "primary",
        onPress: () => onEdit(row.code),
      });
    }
    return actions;
  }, [onEdit, onShare, row.code]);

  return (
    <SwipeableRow
      right={swipeActions}
      accessibilityLabel={`Discount ${row.code}, ${status.label}`}
    >
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        marginBottom: 8,
        position: "relative",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${expanded ? "Hide" : "Show"} recent redemptions for ${row.code}`}
        onPress={() => {
          haptics.tap();
          onToggle(row.id);
        }}
        // The Share affordance sits on top of this Pressable, so the reserved
        // gutter has to track its width rather than stay a literal 64.
        style={{ padding: 14, paddingEnd: shareSlot + 16 }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            // A discount code is a single unbroken token the operator copies,
            // so it takes the dense `mono` ceiling rather than a prose one: it
            // shares its line with the status pill, and wrapping
            // "BLACKFRIDAY2026" mid-token reads worse than holding it at 1.4x.
            // The deliberate 15pt survives — this is the row's title, and
            // dropping to mono's 13pt would put it below the line under it.
            {...typeCap("mono")}
            style={{
              color: t.fg,
              fontSize: 15,
              lineHeight: 21,
              fontWeight: "700",
              fontFamily: "Menlo",
              flex: 1,
            }}
            numberOfLines={1}
          >
            {row.code}
          </Text>
          <Pill label={status.label} tone={status.tone} />
        </View>

        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontWeight: "500",
            fontFamily: FONT.medium,
          }}
        >
          {formatDiscountOff(row)}
        </Text>

        <View
          style={{
            flexDirection: "row",
            gap: 12,
            marginTop: 8,
            flexWrap: "wrap",
          }}
        >
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fgMuted,
              ...typeStyle("numeric"),
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {cap}
          </Text>
          {applies ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={maxLinesAtScale(1, fontScale)}
            >
              {applies}
            </Text>
          ) : null}
        </View>

        {row.expires_at ? (
          <Text
            {...typeCap("caption")}
            style={{
              // Never colour alone: the word "Expired" carries the state, and
              // the red only reinforces it.
              color: status.label === "expired" ? t.danger : t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 6,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
            numberOfLines={maxLinesAtScale(1, fontScale)}
          >
            {status.label === "expired" ? "Expired " : "Expires "}
            {dateTime(row.expires_at)}
          </Text>
        ) : null}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Share code ${row.code}`}
        hitSlop={8}
        onPress={() => {
          haptics.tap();
          onShare(row.code);
        }}
        style={{
          position: "absolute",
          top: 8,
          // LOGICAL inset, paired with the card's `paddingEnd` reservation
          // below. A physical `right` would keep the share slot on the right of
          // an RTL layout while the padding reserving room for it moved left —
          // the button would then sit on top of the code.
          insetInlineEnd: 8,
          // minWidth rather than width: the box grows with its own label
          // instead of clipping it, and 44pt stays the floor because it is
          // also the touch target.
          minWidth: shareSlot,
          minHeight: 44,
          paddingHorizontal: 6,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("control")}
          numberOfLines={1}
          style={{
            color: t.accent,
            ...typeStyle("control"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Share
        </Text>
      </Pressable>

      {expanded ? (
        <Animated.View
          entering={FadeIn.duration(durationFor("enter", reduceMotion))}
          exiting={FadeOut.duration(durationFor("exit", reduceMotion))}
        >
          <DiscountRedemptionsDrawer
            code={row.code}
            localLabel={status.label}
            redemptions={redemptions}
            used={used}
            createdAt={row.created_at}
            fontScale={fontScale}
            binding={binding}
          />
        </Animated.View>
      ) : null}
    </View>
    </SwipeableRow>
  );
}

export const DiscountCard = memo(DiscountCardImpl);
