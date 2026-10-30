/**
 * CollectionRow — one reference collection in the catalogue.
 *
 * THE HEADLINE IS "WHEN DID THIS LAST CHANGE", not the name alone. The question
 * this surface answers away from a desk is "did the overnight import land, and
 * is it the size it should be" — so the row leads with the name, then states
 * the last update and the row count together, because either on its own is
 * misleading: a fresh timestamp on an empty table is a failed import, and a
 * large count with a month-old timestamp is a table nothing is maintaining.
 *
 * THE COUNT IS NEVER INVENTED. `collectionSizeLabel` renders an em-dash for an
 * unreported count and the word "Empty" for a reported zero, and the row's
 * spoken label carries the full sentence for both — a screen reader must not
 * hear a bare "—".
 *
 * THE TIME IS SAID TWICE, RELATIVELY AND ABSOLUTELY. The list response carries
 * no server snapshot instant (`ListPage` is `{items, total, next_cursor}`,
 * types.go:97-102), so a relative age is measured against THIS DEVICE's clock.
 * That is fine for a payload fetched seconds ago and misleading for one held in
 * memory across an outage, so the absolute timestamp — which cannot drift —
 * sits beside it and is what the spoken label leads with.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import {
  collectionSizeLabel,
  collectionSourceSentence,
  collectionTypeLabel,
} from "@/lib/collectionInventory";
import type { CollectionSummary } from "@/lib/collections";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CollectionRowProps {
  collection: CollectionSummary;
  expanded: boolean;
  onToggle: (id: string) => void;
}

export function CollectionRow({
  collection,
  expanded,
  onToggle,
}: CollectionRowProps) {
  const { t } = useTheme();
  const size = collectionSizeLabel(collection.rowCount);
  const typeLabel = collectionTypeLabel(collection.collectionType);
  const sourceSentence = collectionSourceSentence(collection.sourceType);
  const updatedAbs = dateTime(collection.updatedAt, "");
  const updatedRel = relativeTime(collection.updatedAt, { fallback: "" });
  const name = collection.name.trim() || "Untitled collection";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${name}. ${typeLabel}. ${size.spoken}. ${sourceSentence}. ${
        updatedAbs ? `Updated ${updatedAbs}.` : "Update time not reported."
      }`}
      accessibilityHint={
        expanded ? "Hides this collection's rows" : "Shows this collection's rows"
      }
      onPress={() => onToggle(collection.id)}
      // Static object — a function style silently drops layout on NativeWind v4.
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        minHeight: 44,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("body")}
          numberOfLines={2}
          style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.medium }}
        >
          {name}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            flexWrap: "wrap",
          }}
        >
          <Pill label={typeLabel} tone="neutral" />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
          >
            {updatedRel ? `updated ${updatedRel}` : "update time not reported"}
          </Text>
        </View>
      </View>

      {/* Hidden from assistive tech: the Pressable's own label already carries
          the exact row count as a sentence and the absolute timestamp. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ alignItems: "flex-end", gap: 2, maxWidth: 120 }}
      >
        <Text
          {...typeCap("numeric")}
          numberOfLines={1}
          style={{
            color: size.empty ? t.warning : t.fg,
            ...typeStyle("numeric"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {size.text}
        </Text>
        <Text
          {...typeCap("caption")}
          numberOfLines={1}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {collection.rowCount === null
            ? "not reported"
            : size.empty
              ? "no rows"
              : "rows"}
        </Text>
      </View>
    </Pressable>
  );
}
