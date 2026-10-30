import { Text, View } from "react-native";

import { num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { MobileMigrationResourceProgress as ResourceProgress } from "@/lib/migrationProgress";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function MigrationResourceProgress({
  rows,
}: {
  rows: readonly ResourceProgress[];
}) {
  const { t } = useTheme();
  if (rows.length === 0) return null;

  return (
    <View
      style={{
        gap: 5,
        marginTop: 10,
        paddingTop: 10,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
      }}
    >
      {rows.map((resource) => (
        <View
          key={resource.resource}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          {/* A two-column tabular readout: label left, done/total right. Both
              sides take the DENSE `numeric` role so they stay on one line and
              at one size as the OS text setting grows — a prose ceiling on the
              label alone would silently push the figure off the row. */}
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("numeric"),
              flex: 1,
              fontFamily: FONT.regular,
            }}
          >
            {resource.label}
          </Text>
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fg,
              ...typeStyle("numeric"),
              fontVariant: ["tabular-nums"],
              fontFamily: FONT.semibold,
            }}
          >
            {num(resource.done)} / {num(resource.total)}
          </Text>
        </View>
      ))}
    </View>
  );
}
