/**
 * One cell of the Images grid.
 *
 * `React.memo` is the whole point of this file: the grid re-renders on every
 * keystroke in the search field and on opening or closing the detail sheet, and
 * without the memo every visible thumbnail re-decodes. The memo only holds if
 * its props keep their identity, which is why `useAssetsScreen` builds
 * `onPress` with `useCallback` rather than inside `renderItem`.
 *
 * `alone` handles the odd last row: a two-column grid whose final item has no
 * partner would otherwise stretch that thumbnail to full width.
 */
import { memo } from "react";
import { View } from "react-native";

import { AssetTile } from "@/components/assets/AssetTile";
import type { MobileAsset } from "@/lib/assetLibrary";

export const AssetGridCell = memo(function AssetGridCell({
  asset,
  baseUrl,
  alone,
  onPress,
}: {
  asset: MobileAsset;
  baseUrl: string | null;
  /**
   * A lone tile on the final row would otherwise stretch to the full width and
   * read as a different, more important kind of thing. The spacer keeps every
   * tile the same size as every other tile.
   */
  alone: boolean;
  onPress: (asset: MobileAsset) => void;
}) {
  const tile = <AssetTile asset={asset} baseUrl={baseUrl} onPress={onPress} />;
  return alone ? (
    <View style={{ flex: 1, flexDirection: "row", gap: 12 }}>
      {tile}
      <View style={{ flex: 1 }} />
    </View>
  ) : (
    tile
  );
});
