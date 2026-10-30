/**
 * The subscribers screen's filter header: lateral audience nav, search,
 * status chips, the count + freshness line, and the sort control.
 *
 * Extracted from app/(tabs)/subscribers/index.tsx, whose single screen function
 * had grown past the function-size budget once sort and freshness landed.
 * It takes state and callbacks only — no queries, no mutations — so the
 * screen stays the one place that owns data.
 */
import { Pressable, ScrollView, Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { SearchField } from "@/components/SearchField";
import {
  AudienceNav,
  SUBSCRIBERS_ROUTE,
} from "@/components/subscriber/AudienceNav";
import { SubscriberSortControl } from "@/components/subscriber/SubscriberSortControl";
import { FONT } from "@/lib/fonts";
import { SUBSCRIBER_STATUS_FILTERS } from "@/lib/subscriberStatus";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscribersListHeader({
  query,
  onQueryChange,
  resultCount,
  filterKey,
  onFilterChange,
  countLine,
  freshness,
  sortKey,
  sortOpen,
  onSortOpen,
  onSortClose,
  onSortChange,
  includeArchived,
  onToggleArchived,
  onExport,
  exporting,
  onOpenScores,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  /** Server total while searching; omit to hide the spoken result count. */
  resultCount?: number | undefined;
  filterKey: string;
  onFilterChange: (key: string) => void;
  /** "Showing 25 of 1,340 subscribers", or "" when there is nothing to say. */
  countLine: string;
  /** "4m ago", or "" before the first successful load. */
  freshness: string;
  sortKey: string;
  sortOpen: boolean;
  onSortOpen: () => void;
  onSortClose: () => void;
  onSortChange: (key: string) => void;
  /**
   * AUDIENCE#56. Note the wording everywhere below: `?include_archived=true`
   * ADDS soft-deleted rows to the active ones (handlers.go:246 →
   * repo.go:355), it does not switch to an archived-only view. A chip reading
   * "Archived" would promise a filter the endpoint does not implement.
   */
  includeArchived: boolean;
  onToggleArchived: () => void;
  /**
   * Share the APPLIED view as CSV (viewer-scoped server export, SUB-107).
   * Omitted → no pill, so screens that cannot export never show a dead
   * control. Availability rules live in useSubscribersExport.
   */
  onExport?: (() => void) | undefined;
  exporting?: boolean | undefined;
  /** Opens the engagement-score explorer. Omitted → no pill. */
  onOpenScores?: (() => void) | undefined;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 8,
        gap: 10,
      }}
    >
      <AudienceNav active={SUBSCRIBERS_ROUTE} />
      <SearchField
        value={query}
        onChangeText={onQueryChange}
        placeholder="Search by email, name, tag, or custom field…"
        accessibilityLabel="Search subscribers"
        {...(resultCount == null ? {} : { resultCount })}
        resultNoun="matching subscriber"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 6, paddingEnd: 8 }}
      >
        {SUBSCRIBER_STATUS_FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            active={filterKey === f.key}
            onPress={() => onFilterChange(f.key)}
            accessibilityLabel={
              f.key === "all"
                ? "Show all subscribers"
                : `Show ${f.label.toLowerCase()} subscribers only`
            }
          />
        ))}
        {/* Orthogonal to the status chips — soft-deletion is a different axis
            from consent state — so it sits at the end of the same rail rather
            than pretending to be a sixth status. */}
        <Chip
          label="+ Archived"
          active={includeArchived}
          onPress={onToggleArchived}
          accessibilityLabel={
            includeArchived
              ? "Hide archived contacts. Currently included."
              : "Also show archived contacts alongside active ones"
          }
        />
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          {countLine ? (
            <Text
              {...typeCap("label")}
              // Tapping a status chip changed the list and the count silently.
              // SearchField announces a SEARCH result count, but nothing
              // announced a FILTER one, so a VoiceOver user got no
              // confirmation that the chip they just selected did anything.
              accessibilityLiveRegion="polite"
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {countLine}
            </Text>
          ) : null}
          {/* These screens are routinely resumed hours later from the
              background, so say how old the numbers are rather than
              presenting them as live. */}
          {freshness ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
              accessibilityLabel={`Last updated ${freshness}`}
            >
              {`Updated ${freshness}`}
            </Text>
          ) : null}
        </View>
        {onExport ? (
          <Pressable
            onPress={onExport}
            disabled={Boolean(exporting)}
            accessibilityRole="button"
            accessibilityLabel={
              exporting
                ? "Exporting the current subscriber view"
                : "Share the current subscriber view as CSV"
            }
            // NativeWind v4: static style object only.
            style={{
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 999,
              paddingHorizontal: 12,
              paddingVertical: 8,
              minHeight: 44,
              justifyContent: "center",
              backgroundColor: t.surface,
              opacity: exporting ? 0.6 : 1,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fgMuted,
                ...typeStyle("control"),
                fontFamily: FONT.medium,
              }}
              numberOfLines={1}
            >
              {exporting ? "Exporting…" : "Export"}
            </Text>
          </Pressable>
        ) : null}
        {onOpenScores ? (
          <Pressable
            onPress={onOpenScores}
            accessibilityRole="button"
            accessibilityLabel="Open the engagement score explorer"
            // NativeWind v4: static style object only.
            style={{
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 999,
              paddingHorizontal: 12,
              paddingVertical: 8,
              minHeight: 44,
              justifyContent: "center",
              backgroundColor: t.surface,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fgMuted,
                ...typeStyle("control"),
                fontFamily: FONT.medium,
              }}
              numberOfLines={1}
            >
              Scores
            </Text>
          </Pressable>
        ) : null}
        <SubscriberSortControl
          value={sortKey}
          open={sortOpen}
          onOpen={onSortOpen}
          onClose={onSortClose}
          onChange={onSortChange}
        />
      </View>
    </View>
  );
}
