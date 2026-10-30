/**
 * ListRow — one row of the lists catalogue.
 *
 * Two things changed. It is now a Pressable that routes to the list detail
 * screen (the old row was a plain `View` with no route target, so tapping a
 * list did nothing, which reads as a broken screen). And it is `memo()`'d
 * behind a stable `renderItem`, so typing in the debounced search no longer
 * re-renders every mounted ~90-line row.
 */
import { memo } from "react";
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { compactNum, exact, plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ListCatalogueRow {
  id: number | string;
  name: string;
  type?: string;
  optin?: string;
  tags?: string[];
  description?: string;
  count?: number;
}

function ListRowBody({ row }: { row: ListCatalogueRow }) {
  const { t } = useTheme();
  const name = row.name || `List ${row.id}`;
  const hasCount = typeof row.count === "number" && Number.isFinite(row.count);
  const spoken = [
    name,
    hasCount ? exact(row.count, "subscribers") : "subscriber count unknown",
    row.type,
    row.optin ? `${row.optin} opt-in` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Link
      href={{ pathname: "/(tabs)/lists/[id]", params: { id: String(row.id) } }}
      asChild
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open list ${spoken}`}
        // NativeWind v4: static style object only — a function-style style
        // prop on Pressable silently drops layout.
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          // A DECLARED tap-target floor. The row cleared 44pt only because
          // of the font sizes it happens to render today; shrink the content
          // to one short line, or drop Dynamic Type to its smallest step, and
          // it silently fell under the threshold with nothing enforcing it.
          minHeight: 64,
          marginBottom: 8,
        }}
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
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flex: 1,
            }}
            numberOfLines={1}
          >
            {name}
          </Text>
          {/* `numeric`: the count is pinned to the right of the name's row,
              and its exact value is already spoken below. */}
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fg,
              ...typeStyle("numeric"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              fontVariant: ["tabular-nums"],
            }}
            // A compacted number always carries its exact spoken form.
            accessibilityLabel={
              hasCount ? exact(row.count, "subscribers") : "Count unavailable"
            }
          >
            {compactNum(row.count)}
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
            flexWrap: "wrap",
          }}
        >
          {row.type ? <Pill label={row.type} tone="neutral" /> : null}
          {row.optin ? (
            <Pill
              label={`${row.optin} opt-in`}
              tone={row.optin.toLowerCase() === "double" ? "success" : "neutral"}
            />
          ) : null}
          {row.tags && row.tags.length > 0 ? (
            <Text
              {...typeCap("badgeSmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("badgeSmall"),
                fontFamily: FONT.regular,
                flexShrink: 1,
              }}
              numberOfLines={1}
              accessibilityLabel={plural(row.tags.length, "tag")}
            >
              {row.tags.slice(0, 4).join(", ")}
            </Text>
          ) : null}
        </View>
        {row.description ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
            numberOfLines={2}
          >
            {row.description}
          </Text>
        ) : null}
      </Pressable>
    </Link>
  );
}

export const ListRow = memo(ListRowBody);
