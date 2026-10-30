/**
 * DiscountRedemptionsDrawer — the expanded half of a discount card.
 *
 * Split out of `app/(tabs)/discounts.tsx` when the Dynamic Type pass pushed
 * that file past its source budget. The seam is real rather than mechanical:
 * the card above is a summary the operator scans, this is a per-code audit
 * they open one at a time, and it owns its own four-state ladder (fetching /
 * failed / empty / rows) plus the truncation footnote.
 *
 * IT SAYS WHEN IT IS SHOWING A SLICE. The first read is `?limit=10`, so on a
 * code redeemed 400 times the ten rows here are not the story. `used >
 * rows.length` is the signal available client-side that the list is partial,
 * and the footnote states it rather than letting ten rows imply ten
 * redemptions, with "Load more" underneath so the sentence is not terminal.
 * The whole-set CSV that used to sit next to it is unmounted.
 *
 * IT STATES WHAT IT CANNOT DO. `DiscountRedeemability` above the rows says the
 * live probe is unavailable, so the derived pill on the card does not borrow
 * the authority of a verdict nobody issued; the block below the actions says
 * the code cannot be withdrawn from Moosewave at all. Both are omissions that
 * would be misread as silence, so both are spoken.
 */
import { Pressable, Text, View } from "react-native";

import { SkeletonList } from "@/components/Skeleton";
import { DiscountDrawerActions } from "@/components/discounts/DiscountDrawerActions";
import {
  DiscountRedeemability,
  type DiscountCheckQuery,
} from "@/components/discounts/DiscountRedeemability";
import {
  redemptionActor,
  type DiscountStatusLabel,
} from "@/components/discounts/discountStatus";
import type { DiscountRedemptionRow } from "@/hooks/useDiscountOps";
import {
  DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE,
  discountKillSwitchAvailable,
} from "@/lib/discountMutationBoundary";
import { FONT } from "@/lib/fonts";
import { dateTime, num, relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Everything the drawer needs that only the EXPANDED row has.
 *
 * Bundled into one object so the collapsed rows can be handed a single frozen
 * constant: `DiscountCard` is memoised, and seven separate props recreated per
 * render would defeat that for all two hundred rows every time the open drawer
 * polled.
 */
export interface DiscountDrawerBinding {
  check: DiscountCheckQuery;
  /** True when the last page came back full, so the server may hold more. */
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  exporting: boolean;
  /**
   * Null when the whole-set CSV export is unreachable — either the session's
   * role cannot use it, or the route is not mounted at all
   * (lib/discountMutationBoundary). Absent beats disabled on a phone.
   */
  onExport: ((code: string, total: number) => void) | null;
  /** Null when the session's role cannot PATCH a discount, or PATCH is unmounted. */
  onEdit: ((code: string) => void) | null;
  /**
   * Null when the session's role cannot DELETE a discount, or the kill switch
   * is not reachable in this build (lib/discountMutationBoundary).
   */
  onDelete: ((code: string, used: number) => void) | null;
  deleting: boolean;
}

export interface DiscountRedemptionsDrawerProps {
  code: string;
  /** The label `statusOf()` derived from the list row, for the disagreement check. */
  localLabel: DiscountStatusLabel;
  /** The `useDiscountRedemptions` query, narrowed to what is rendered. */
  redemptions: {
    isFetching: boolean;
    isError: boolean;
    error: unknown;
    data: DiscountRedemptionRow[] | undefined;
    refetch: () => unknown;
  };
  /** Lifetime redemption count from the code itself, not from these rows. */
  used: number;
  createdAt: string | undefined;
  fontScale: number;
  binding: DiscountDrawerBinding;
}

export function DiscountRedemptionsDrawer({
  code,
  localLabel,
  redemptions,
  used,
  createdAt,
  fontScale,
  binding,
}: DiscountRedemptionsDrawerProps) {
  const { t } = useTheme();
  const rows = Array.isArray(redemptions.data) ? redemptions.data : [];
  // The skeleton branch below owns the FIRST load. A "Load more" fetch keeps
  // the previous window on screen (placeholderData), so `isFetching` with rows
  // present is growth, not a cold load.
  const firstLoad = redemptions.isFetching && rows.length === 0;
  return (
    <View
      style={{
        marginHorizontal: 14,
        marginBottom: 14,
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
      }}
    >
      <DiscountRedeemability localLabel={localLabel} check={binding.check} />

      <Text
        accessibilityRole="header"
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontWeight: "700",
          fontFamily: FONT.bold,
          marginBottom: 8,
        }}
      >
        Recent redemptions
      </Text>

      {firstLoad ? (
        // A content-shaped placeholder, not a "Loading…" string: the drawer
        // keeps the height it is about to have, so the card below it doesn't
        // jump when the rows land. Two lines per card mirrors actor + time.
        <SkeletonList rows={2} lines={2} label="Loading redemption events" />
      ) : redemptions.isError ? (
        <View style={{ gap: 8 }}>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.danger,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {redemptions.error instanceof Error
              ? redemptions.error.message
              : "Couldn't load redemptions"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading redemptions"
            hitSlop={6}
            onPress={() => void redemptions.refetch()}
            style={{
              alignSelf: "flex-start",
              minHeight: 44,
              justifyContent: "center",
              paddingHorizontal: 8,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Retry
            </Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          No redemption events yet.
        </Text>
      ) : (
        <View style={{ gap: 8 }}>
          {rows.map((item) => (
            <View
              key={item.id}
              style={{
                backgroundColor: t.bg,
                borderColor: t.borderSubtle,
                borderWidth: 1,
                borderRadius: 10,
                padding: 10,
              }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
                // An address truncated to "alexandra.mor…" identifies nobody,
                // so a raised OS text size buys a second line.
                numberOfLines={maxLinesAtScale(1, fontScale)}
              >
                {redemptionActor(item)}
              </Text>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  marginTop: 2,
                  fontFamily: FONT.regular,
                  fontVariant: ["tabular-nums"],
                }}
                accessibilityLabel={dateTime(item.redeemed_at)}
              >
                {relativeTime(item.redeemed_at)}
              </Text>
            </View>
          ))}
          {used > rows.length ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              Showing latest {num(rows.length)} of {num(used)} redemptions.
            </Text>
          ) : null}
        </View>
      )}

      <DiscountDrawerActions
        code={code}
        used={used}
        shown={rows.length}
        canLoadMore={binding.canLoadMore}
        loadingMore={binding.loadingMore}
        onLoadMore={binding.onLoadMore}
        exporting={binding.exporting}
        onExport={binding.onExport}
        onEdit={binding.onEdit}
        onDelete={binding.onDelete}
        deleting={binding.deleting}
      />

      {/* The one absence stated rather than merely omitted. Every other
          unreachable affordance leaves nothing behind, which is right: nobody
          opens a discount drawer hoping to export a CSV. They DO open it at 2am
          because a code leaked, and an empty row of buttons lets that operator
          conclude they mis-tapped — or worse, that they already stopped it. */}
      {!discountKillSwitchAvailable() ? (
        <View
          accessible
          accessibilityLabel={DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE.spoken}
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.borderSubtle,
            backgroundColor: t.bg,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE.headline}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 3,
              fontFamily: FONT.regular,
            }}
          >
            {DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE.detail}
          </Text>
        </View>
      ) : null}

      {createdAt ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 10,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          Created {dateTime(createdAt)}
        </Text>
      ) : null}
    </View>
  );
}
