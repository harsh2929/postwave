/**
 * ProductEventCatalogSection — the catalogue itself: which events arrived, and
 * which ones stopped.
 *
 * SORTED BY SILENCE BY DEFAULT. Every other list in this app leads with the
 * biggest number; this one must not. A stopped event is by definition the one
 * whose volume has flatlined, so a volume-sorted catalogue buries it beneath
 * everything still working. "Needs a look" ranks silent first, then rows whose
 * freshness the payload didn't let us determine, then quiet, then live — and
 * ties break on volume so the biggest silent event leads. "Busiest" is offered
 * because it answers a different, legitimate question, and it is never the
 * default.
 *
 * THE DISCLOSURES ARE PART OF THE DATA. `catalogNotes` returns the sentences
 * that keep this list from being misread — the window it covers, the 200-row
 * cap, the two different windows inside one row, and the fact that its
 * first/last-seen are window bounds rather than lifetime bounds. They are
 * rendered underneath every non-empty list, not hidden behind an info icon,
 * because a reader who has already drawn a conclusion will not go looking.
 *
 * ABSENCE IS NOT ZERO — the load-bearing case on this surface. The catalogue is
 * `GROUP BY event_name` inside the window (track/extras.go:240-252), so an
 * event that stopped BEFORE the window has no row at all. It never appears with
 * a count of 0, which means "my event is missing from this list" is a finding,
 * not a bug, and the note says so.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Fragment } from "react";
import { Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SearchField } from "@/components/SearchField";
import { SectionLabel } from "@/components/SectionLabel";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { ProductEventRow } from "@/components/product-events/ProductEventRow";
import { ProductEventSamplePanel } from "@/components/product-events/ProductEventSamplePanel";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import {
  catalogHeadline,
  catalogNotes,
  filterProductEvents,
  orderProductEvents,
  type ProductEventOrder,
} from "@/lib/productEventHealth";
import type {
  ProductEventCatalog,
  ProductEventSample,
} from "@/lib/productEvents";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const ORDER_OPTIONS: readonly { value: ProductEventOrder; label: string }[] = [
  { value: "attention", label: "Needs a look" },
  { value: "volume", label: "Busiest" },
];

export interface ProductEventCatalogSectionProps {
  catalog: QueryLike & { data?: ProductEventCatalog | undefined };
  sample: QueryLike & { data?: ProductEventSample | undefined };
  gate: Pick<OnlineQueryGate, "enabled">;
  order: ProductEventOrder;
  onOrderChange: (next: ProductEventOrder) => void;
  query: string;
  onQueryChange: (next: string) => void;
  expandedName: string | null;
  onToggleRow: (eventName: string) => void;
}

export function ProductEventCatalogSection({
  catalog,
  sample,
  gate,
  order,
  onOrderChange,
  query,
  onQueryChange,
  expandedName,
  onToggleRow,
}: ProductEventCatalogSectionProps) {
  const { t } = useTheme();
  const payload = catalog.data;
  const all = payload?.items ?? [];
  const measuredAt = payload?.asOf ?? "";
  const visible = orderProductEvents(
    filterProductEvents(all, query),
    measuredAt,
    order,
  );
  const headline = catalogHeadline(all, measuredAt);
  const notes = payload ? catalogNotes(payload) : [];

  return (
    <View>
      <SectionLabel topMargin={24}>Event catalogue</SectionLabel>
      <QueryStates
        query={catalog}
        gate={gate}
        isEmpty={all.length === 0}
        offlineMessage="The event catalogue needs a connection. Reconnect and pull to refresh — this is not the same as receiving no events."
        skeleton={<SkeletonList rows={5} lines={2} label="Loading the event catalogue" />}
        empty={{
          title: "No events in this window",
          description:
            "Nothing was tracked in the selected period. Widen the window before concluding the integration is dead — an event that stopped earlier is missing from this list, not zero.",
        }}
      >
        {headline ? (
          <Text
            // A summary of the list below it, so it is announced as a live
            // region: changing the window rewrites this sentence and a
            // VoiceOver user would otherwise never hear that it changed.
            accessibilityLiveRegion="polite"
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginBottom: 10,
            }}
          >
            {headline}
          </Text>
        ) : null}

        <SegmentedControl
          options={ORDER_OPTIONS}
          value={order}
          onChange={onOrderChange}
          accessibilityLabel="Catalogue order"
        />

        {all.length > 8 ? (
          <View style={{ marginTop: 10 }}>
            <SearchField
              value={query}
              onChangeText={onQueryChange}
              placeholder="Filter event names"
              accessibilityLabel="Filter event names"
              resultCount={visible.length}
              resultNoun="event"
            />
          </View>
        ) : null}

        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 14,
            paddingHorizontal: 14,
            paddingBottom: 4,
            marginTop: 10,
          }}
        >
          {visible.length === 0 ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                paddingVertical: 14,
              }}
            >
              {`No event name matches “${query.trim()}” in this window.`}
            </Text>
          ) : null}
          {visible.map((row) => (
            <Fragment key={row.eventName}>
              <ProductEventRow
                row={row}
                measuredAt={measuredAt}
                periodDays={payload?.periodDays ?? 0}
                seriesDays={payload?.dailySeriesPeriodDays ?? 0}
                expanded={expandedName === row.eventName}
                onToggle={onToggleRow}
              />
              {expandedName === row.eventName ? (
                <ProductEventSamplePanel
                  eventName={row.eventName}
                  sample={sample}
                  gate={gate}
                />
              ) : null}
            </Fragment>
          ))}
        </View>

        {notes.map((note) => (
          <Text
            key={note}
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 8,
            }}
          >
            {note}
          </Text>
        ))}
      </QueryStates>
    </View>
  );
}
