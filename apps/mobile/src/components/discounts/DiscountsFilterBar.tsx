/**
 * DiscountsFilterBar — the search field, the four status chips and the count
 * line above the discount list.
 *
 * Split out of `app/(tabs)/discounts.tsx` when the screen grew a live
 * redeemability probe, a CSV export and an edit sheet: the header is a stable
 * block that reads only four values, so leaving it inline meant every one of
 * its sixty-five lines counted against the screen's function budget for no
 * benefit.
 *
 * THE CHIP COUNTS ARE TOTALS, NOT RESULT COUNTS. Each chip states how many
 * codes are in that bucket across the whole catalogue, which is why they do not
 * change as you type — the filtered count is the separate line underneath. A
 * chip whose number moved with the search box would be answering a question
 * nobody asked.
 */
import { Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { SearchField } from "@/components/SearchField";
import type { DiscountStatusFilter } from "@/hooks/useDiscountsScreen";
import { FONT } from "@/lib/fonts";
import { num, plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DiscountsSummary {
  all: number;
  active: number;
  exhausted: number;
  expired: number;
  redemptions: number;
}

const CHIPS: readonly {
  key: DiscountStatusFilter;
  label: string;
  spoken: string;
}[] = [
  { key: "all", label: "All", spoken: "All discounts" },
  { key: "active", label: "Active", spoken: "Active discounts" },
  { key: "exhausted", label: "Exhausted", spoken: "Exhausted discounts" },
  { key: "expired", label: "Expired", spoken: "Expired discounts" },
];

export interface DiscountsFilterBarProps {
  q: string;
  onChangeQ: (next: string) => void;
  /** Rows after filtering; undefined while there is no active search. */
  resultCount: number | undefined;
  filter: DiscountStatusFilter;
  onChangeFilter: (next: DiscountStatusFilter) => void;
  summary: DiscountsSummary;
  visibleCount: number;
  hasFilter: boolean;
}

export function DiscountsFilterBar({
  q,
  onChangeQ,
  resultCount,
  filter,
  onChangeFilter,
  summary,
  visibleCount,
  hasFilter,
}: DiscountsFilterBarProps) {
  const { t } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
      {/* The shared field, not a hand-rolled TextInput: it brings a 44pt clear
          button, returnKeyType="search", and a polite live region that
          announces the result count as you type. `autoCapitalize="characters"`
          is kept because discount codes are an all-caps identifier space. */}
      <SearchField
        value={q}
        onChangeText={onChangeQ}
        accessibilityLabel="Search by code"
        placeholder="Search by code…"
        autoCapitalize="characters"
        {...(resultCount === undefined ? {} : { resultCount })}
        resultNoun="code"
      />
      <View
        style={{
          flexDirection: "row",
          gap: 6,
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        {CHIPS.map((chip) => (
          <Chip
            key={chip.key}
            label={`${chip.label} ${num(summary[chip.key])}`}
            accessibilityLabel={`${chip.spoken}, ${summary[chip.key]}`}
            active={filter === chip.key}
            onPress={() => onChangeFilter(chip.key)}
          />
        ))}
      </View>
      {summary.all > 0 ? (
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
          {hasFilter
            ? `${num(visibleCount)} of ${plural(summary.all, "code")} · `
            : `${plural(summary.all, "code")} · `}
          {plural(summary.redemptions, "lifetime redemption")}
        </Text>
      ) : null}
    </View>
  );
}
