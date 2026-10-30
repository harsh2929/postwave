/**
 * StoreRecoverySection — "who did we promise something to, and have we told
 * them yet?"
 *
 * WHY IT IS HERE AND NOT ON ITS OWN SCREEN. The desktop keeps this as a
 * 1,408-line RecoveryTab beside the store's orders, and the read is the same
 * read: it is scoped to ONE integration, it uses the store the operator
 * already selected above, and it is refreshed by the same pull gesture. A
 * separate mobile destination would have made the operator pick a store twice.
 *
 * WHAT IS DELIBERATELY ABSENT. All three CREATE routes exist
 * (`POST /{id}/cart-recovery-links`, `POST /{id}/products/{product_id}/…`,
 * commerce/handlers.go:152,154,156) and all three are `ScopeAdmin`. Two of
 * them additionally need a `product_id` — a uuid the phone has no product
 * browser to pick from, since the recovery lists carry a product id and no
 * product TITLE. Offering "add a watcher" here would mean asking an operator
 * to type a uuid on a phone. So this surface is read-only, and says so by
 * simply having no buttons rather than by disabling any.
 *
 * THE NUMBER THIS SECTION EXISTS FOR is not the row count — it is the count of
 * rows the server marked `eligible` and never notified. That is a promise made
 * to a shopper and not yet kept, and `recoverySummary` states it with its
 * denominator every time because the phone reads ONE page.
 *
 * NativeWind v4: static style objects only.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { RecoveryRow } from "@/components/commerce/RecoveryRow";
import { useCommerceRecovery } from "@/hooks/useCommerce";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  awaitingNotice,
  longestWaitMs,
  recoverySummary,
  type RecoveryKind,
  type RecoveryPage,
} from "@/lib/commerceRecovery";
import { duration } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const KINDS: readonly { value: RecoveryKind; label: string }[] = [
  { value: "carts", label: "Carts" },
  { value: "back-in-stock", label: "Back in stock" },
  { value: "price-drops", label: "Price drops" },
];

const EMPTY: Record<RecoveryKind, { title: string; description: string }> = {
  carts: {
    title: "No recovery links",
    description:
      "No abandoned-cart links have been created for this store. They are created by the web admin or by an integration, not from a phone.",
  },
  "back-in-stock": {
    title: "Nobody is waiting on stock",
    description:
      "No shopper has asked to be told when something comes back in stock for this store.",
  },
  "price-drops": {
    title: "No price watchers",
    description:
      "No shopper is watching a price on this store.",
  },
};

/**
 * Unlike its siblings on this screen, this section OWNS its query.
 *
 * The parent hands `refetch` functions to `useManualRefresh`, so an owned
 * query is normally a query pull-to-refresh cannot reach — which is why
 * `StoreOrdersSection` takes its query as a prop. Here the query key depends
 * on a selection this component holds, and lifting that selection to the
 * parent would put a tab choice into a screen that has nothing else to do with
 * it. The trade is paid for below: TanStack refetches an ACTIVE query on
 * window focus and on reconnect, and the section additionally states how stale
 * it may be, so the pull gesture is not the only path to fresh rows.
 */
export function StoreRecoverySection({
  integrationId,
  gate,
}: {
  integrationId: string | null;
  gate: Pick<OnlineQueryGate, "enabled">;
}) {
  const { t } = useTheme();
  const [kind, setKind] = useState<RecoveryKind>("back-in-stock");
  const recovery = useCommerceRecovery(integrationId, kind);
  const page: RecoveryPage = recovery.data ?? {
    items: [],
    sampled: 0,
    hasMore: false,
  };

  return (
    <View>
      <SectionLabel topMargin={24}>Waiting to be told</SectionLabel>
      <View style={{ marginBottom: 12 }}>
        <SegmentedControl
          options={KINDS.map((option) => ({
            ...option,
            // The badge is the URGENT count, not the row count — a "12" that
            // meant "12 rows exist" would compete with the number that matters
            // and win, because it is always larger.
            ...(option.value === kind && awaitingNotice(page.items) > 0
              ? { badge: awaitingNotice(page.items) }
              : {}),
            accessibilityLabel:
              option.value === kind && awaitingNotice(page.items) > 0
                ? `${option.label}, ${awaitingNotice(page.items)} waiting to be told`
                : option.label,
          }))}
          value={kind}
          onChange={setKind}
          accessibilityLabel="Recovery queue"
        />
      </View>

      <QueryStates
        query={recovery}
        gate={gate}
        isEmpty={page.sampled === 0}
        offlineMessage="Reconnect to read who is still waiting to hear from this store."
        skeleton={<SkeletonList rows={3} lines={2} label="Loading recovery queue" />}
        empty={EMPTY[kind]}
      >
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 14,
            paddingHorizontal: 14,
            paddingBottom: 2,
          }}
        >
          <SummaryLine page={page} />
          {page.items.map((row) => (
            <RecoveryRow key={row.id} row={row} />
          ))}
        </View>
      </QueryStates>
    </View>
  );
}

/**
 * The sentence above the rows.
 *
 * Two facts, in the order an operator needs them: how many are owed a message,
 * and how long the oldest one has been owed it. The second is dropped entirely
 * — not shown as "0" — when no eligible row carried an `eligible_at`, because
 * an unmeasured wait is not a zero-length wait.
 */
function SummaryLine({ page }: { page: RecoveryPage }) {
  const { t } = useTheme();
  const summary = recoverySummary(page);
  if (!summary) return null;
  const waited = longestWaitMs(page.items, Date.now());
  const oldest =
    waited === null ? "" : ` Oldest has waited ${duration(waited)}.`;
  const urgent = awaitingNotice(page.items) > 0;

  return (
    <Text
      accessible
      {...typeCap("caption")}
      style={{
        color: urgent ? t.warning : t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: urgent ? FONT.medium : FONT.regular,
        paddingTop: 12,
        paddingBottom: 2,
      }}
    >
      {`${summary}${oldest}`}
    </Text>
  );
}
