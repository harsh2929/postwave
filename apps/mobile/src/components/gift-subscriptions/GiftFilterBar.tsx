/** Server-backed search and lifecycle filters for the sanitized archive. */
import { Text, View } from "react-native";

import { SearchField } from "@/components/SearchField";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/SegmentedControl";
import { num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  giftHistoryQueryPrefix,
  type GiftHistoryFilter,
  type GiftHistorySort,
} from "@/lib/giftSubscriptions";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const OPTIONS: readonly SegmentedOption<GiftHistoryFilter>[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "redeemed", label: "Redeemed" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
  { value: "refunded", label: "Refunded" },
];

const SORT_OPTIONS: readonly SegmentedOption<GiftHistorySort>[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "duration", label: "Duration" },
  { value: "status", label: "Status" },
];

export function GiftFilterBar({
  query,
  onChangeQuery,
  filter,
  onChangeFilter,
  sort,
  onChangeSort,
  total,
}: {
  query: string;
  onChangeQuery: (next: string) => void;
  filter: GiftHistoryFilter;
  onChangeFilter: (next: GiftHistoryFilter) => void;
  sort: GiftHistorySort;
  onChangeSort: (next: GiftHistorySort) => void;
  total: number | null;
}) {
  const { t } = useTheme();
  const invalidQuery =
    query.trim() !== "" && giftHistoryQueryPrefix(query) === undefined;
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 10,
        gap: 8,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        backgroundColor: t.bg,
      }}
    >
      <SearchField
        value={query}
        onChangeText={onChangeQuery}
        placeholder="Gift record prefix"
        accessibilityLabel="Search Gift history by record prefix"
        {...(total === null ? {} : { resultCount: total })}
        resultNoun="record"
      />
      <SegmentedControl
        options={OPTIONS}
        value={filter}
        onChange={onChangeFilter}
        accessibilityLabel="Filter Gift history by lifecycle state"
        scrollable
      />
      <SegmentedControl
        options={SORT_OPTIONS}
        value={sort}
        onChange={onChangeSort}
        accessibilityLabel="Sort Gift history"
        scrollable
      />
      <Text
        accessibilityLiveRegion="polite"
        {...typeCap("caption")}
        style={{
          color: invalidQuery ? t.warning : t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {invalidQuery
          ? "Enter 8–32 hexadecimal characters from a Gift record label. This edit is not sent; results keep the last accepted prefix, or the initial unfiltered view."
          : `Search checks the opaque record prefix only. Identities, messages and payment-provider references never enter this reporting view${
              total === null ? "." : ` · ${num(total)} matching.`
            }`}
      </Text>
    </View>
  );
}
