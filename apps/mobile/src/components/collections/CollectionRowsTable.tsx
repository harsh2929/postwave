/**
 * CollectionRowsTable — a bounded, honest preview of somebody else's JSON.
 *
 * NOT A SPREADSHEET, and it should not try to be. Rows are heterogeneous maps
 * (`types.go:58`) with up to 100 fields each, so a real grid would need
 * horizontal scrolling, sticky headers and column sizing — none of which a
 * phone reads well and all of which the desktop already has. This renders a
 * FIELD-PER-LINE card per row, which degrades gracefully when row 3 carries a
 * field rows 1 and 2 do not.
 *
 * WHAT IT REFUSES TO DO. It does not hide a field that is absent from one row
 * and present in another — the em-dash IS the finding when an import dropped a
 * column halfway through a file. It does not print a stored `null` as blank.
 * It does not render string values raw: `lib/collectionRows` strips the
 * text-direction runes the server permits inside values, and the panel above
 * says so when it happened.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import type { CollectionDataRow } from "@/lib/collections";
import {
  formatCollectionCell,
  type CollectionColumns,
} from "@/lib/collectionRows";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CollectionRowsTableProps {
  rows: readonly CollectionDataRow[];
  columns: CollectionColumns;
}

export function CollectionRowsTable({ rows, columns }: CollectionRowsTableProps) {
  const { t } = useTheme();
  if (columns.names.length === 0) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        These rows carry no fields at all — every row in the preview is an empty
        object.
      </Text>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {rows.map((row, index) => (
        <View
          key={index}
          accessible
          accessibilityLabel={`Row ${index + 1}. ${columns.names
            .map((name) => `${name}: ${cellSpoken(row, name)}`)
            .join(". ")}`}
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 12,
            padding: 10,
            gap: 4,
          }}
        >
          {columns.names.map((name) => {
            const cell = formatCollectionCell(row, name);
            return (
              <View
                key={name}
                style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
              >
                <Text
                  {...typeCap("caption")}
                  numberOfLines={1}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                    minWidth: 88,
                    maxWidth: 128,
                  }}
                >
                  {name}
                </Text>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: cell.missing ? t.fgSubtle : t.fg,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                    flex: 1,
                  }}
                >
                  {cell.text}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/**
 * What a screen reader hears for one cell.
 *
 * "not in this row" rather than the em-dash's silence, because the whole reason
 * the em-dash is there is that the field is missing, and a reader who hears
 * nothing learns the opposite of the thing the row is reporting.
 */
function cellSpoken(row: CollectionDataRow, name: string): string {
  const cell = formatCollectionCell(row, name);
  if (cell.missing) return "not in this row";
  if (cell.truncated) return `${cell.text} (clipped)`;
  return cell.text;
}
