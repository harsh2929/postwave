/**
 * ListsStatStrip — the inventory KPIs above the lists catalogue.
 *
 * The counting rules and, more importantly, the HONESTY rule live in
 * src/lib/listInventory.ts (import-free, unit-tested): these figures are sums
 * over the rows the client holds, and the gateway proxies Listmonk's
 * `/api/lists` forwarding only `?query=`, so those rows are the upstream
 * DEFAULT page. This component therefore takes its two headline LABELS from
 * that module rather than hardcoding "Lists" / "Subscribers": a page-1 sum
 * reads as "On loaded lists", and the plain nouns appear only once the
 * envelope's own `total` proves the client holds everything.
 *
 * `computeListsInventory` is re-exported here so existing call sites keep one
 * import; the implementation moved so it could be tested without pulling
 * react-native into the node vitest environment.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { compactNum, exact, percent } from "@/lib/format";
import {
  listsCountLabel,
  listsCoverageNote,
  subscriberSumLabel,
  subscriberSumSpoken,
  type ListsInventory,
} from "@/lib/listInventory";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export {
  computeListsInventory,
  type ListCountable,
  type ListsInventory,
} from "@/lib/listInventory";

function StatCell({
  label,
  value,
  spoken,
  hint,
  highlight,
}: {
  label: string;
  value: string;
  /** Full-precision spoken form for the compacted value. */
  spoken: string;
  hint?: string;
  highlight?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0 }} accessible accessibilityLabel={`${label}: ${spoken}`}>
      {/* All three lines are DENSE roles: the strip is a four-across row of
          `flex: 1` cells, so text that grows without a ceiling squeezes its
          neighbours to nothing rather than reflowing. */}
      <Text
        {...typeCap("badgeSmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("badgeSmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
        numberOfLines={2}
      >
        {label}
      </Text>
      {/* Deliberately 18, not `figure`'s 30: four of these share one row on a
          phone. The `figure` CEILING still applies — it is the tightest in the
          scale precisely for numbers pinned inside a grid. */}
      <Text
        {...typeCap("figure")}
        style={{
          color: highlight ? t.accent : t.fg,
          fontSize: 18,
          lineHeight: 22,
          fontWeight: "700",
          fontFamily: FONT.display,
          fontVariant: ["tabular-nums"],
          marginTop: 2,
        }}
        numberOfLines={1}
      >
        {value}
      </Text>
      {hint ? (
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("badgeSmall"),
            fontFamily: FONT.regular,
            marginTop: 1,
          }}
          numberOfLines={1}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function ListsStatStrip({ stats }: { stats: ListsInventory }) {
  const { t } = useTheme();
  // Guard the rates so an empty set never produces NaN%.
  const publicRate = stats.loaded > 0 ? stats.publicLists / stats.loaded : 0;
  const doubleOptinRate =
    stats.loaded > 0 ? stats.doubleOptin / stats.loaded : 0;
  const note = listsCoverageNote(stats);
  return (
    <View
      style={{
        marginHorizontal: 16,
        marginTop: 8,
        padding: 14,
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", gap: 12 }}>
        <StatCell
          label={listsCountLabel(stats)}
          value={compactNum(stats.loaded)}
          spoken={exact(stats.loaded, "lists")}
        />
        <StatCell
          label={subscriberSumLabel(stats)}
          value={compactNum(stats.subscribers)}
          spoken={subscriberSumSpoken(
            stats,
            exact(stats.subscribers, "subscribers"),
          )}
        />
        <StatCell
          label="Public"
          value={compactNum(stats.publicLists)}
          spoken={exact(stats.publicLists, "public lists")}
          hint={percent(publicRate, { digits: 0 })}
        />
        <StatCell
          label="2x opt-in"
          value={compactNum(stats.doubleOptin)}
          spoken={exact(stats.doubleOptin, "double opt-in lists")}
          highlight={doubleOptinRate >= 0.5}
          hint={percent(doubleOptinRate, { digits: 0 })}
        />
      </View>
      {note ? (
        // The caveat is rendered, not implied. It is also carried inside the
        // subscriber cell's spoken label, so assistive tech never hears the
        // number without it.
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}
