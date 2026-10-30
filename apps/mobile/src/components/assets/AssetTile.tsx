/**
 * AssetTile — one image in the library grid.
 *
 * A thumbnail grid is the only shape this surface can honestly take on a
 * phone: the operator is looking for a picture, and no filename ever told
 * anyone which picture it is. Everything else on the tile exists to answer the
 * two questions a library asks — how big is it, and would deleting it break
 * something.
 *
 * THE PREVIEW CAN LEGITIMATELY FAIL, AND SAYS SO. `Asset.url` is whatever the
 * configured backend returned. S3 and R2 return an absolute public delivery URL
 * that needs no credentials (`Cache-Control: public, …, immutable`,
 * `Content-Disposition: inline`), which is the production path — `selectStorage`
 * refuses to boot without one of them. The dev-only filesystem backend instead
 * returns the RELATIVE `/api/v1/assets/{id}/blob` (storage.go:116), which is an
 * authenticated route: whether the platform's image loader carries the session
 * cookie there is a platform detail this component cannot promise. So it tries,
 * and on failure renders a labelled placeholder naming the format — never a
 * blank square, and never an empty grid cell that reads as "no image".
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo, useState } from "react";
import { Image } from "expo-image";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import {
  absoluteAssetUrl,
  assetDimensions,
  assetUsagePhrase,
  type MobileAsset,
} from "@/lib/assetLibrary";
import { assetSizeLabel } from "@/lib/assetUploadPolicy";
import { FONT } from "@/lib/fonts";
import { EMDASH } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AssetTileProps {
  asset: MobileAsset;
  /** Workspace origin, used to resolve the filesystem backend's relative URL. */
  baseUrl: string | null;
  onPress: (asset: MobileAsset) => void;
}

/** "PNG" / "JPEG" — the part of a mime type a person reads. */
export function assetFormatLabel(mime: string): string {
  const subtype = (mime || "").split("/")[1] ?? "";
  return subtype ? subtype.toUpperCase() : "IMAGE";
}

function AssetTileImpl({ asset, baseUrl, onPress }: AssetTileProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const [previewFailed, setPreviewFailed] = useState(false);

  const uri = absoluteAssetUrl(asset.url, baseUrl);
  const format = assetFormatLabel(asset.mime);
  const dimensions = assetDimensions(asset);
  const size = asset.bytes === null ? EMDASH : assetSizeLabel(asset.bytes);
  const inUse = asset.referencesCount !== null && asset.referencesCount > 0;

  // Spoken once, as a sentence, because every visible part of this tile is
  // compacted: "1.2 MB" and a colour-free "In use" pill are not self-describing.
  const spoken = [
    asset.filename || "Untitled image",
    asset.altText ? `Described as ${asset.altText}` : `${format} image`,
    dimensions ? `${dimensions} pixels` : "Dimensions unknown",
    asset.bytes === null ? "Size unknown" : assetSizeLabel(asset.bytes),
    assetUsagePhrase(asset.referencesCount),
  ].join(". ");

  return (
    <Pressable
      onPress={() => onPress(asset)}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the image, its usage and its address"
      style={{
        flex: 1,
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        overflow: "hidden",
        minHeight: 44,
      }}
    >
      <View
        style={{
          aspectRatio: 1,
          backgroundColor: t.bgSubtle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {uri && !previewFailed ? (
          <Image
            source={{ uri }}
            contentFit="cover"
            // THE REASON THIS IS expo-image AND NOT react-native's Image.
            // This tile lives in a virtualized two-column grid, so its View is
            // RECYCLED: React Native's Image keeps the previous bitmap on the
            // recycled node until the new one decodes, which means a fast
            // scroll shows the WRONG asset under the right filename for a
            // frame or two — a correctness bug on a screen whose entire job is
            // "which picture is this". `recyclingKey` clears the view the
            // moment the identity changes, so a recycled cell renders the
            // placeholder rather than a stale neighbour.
            recyclingKey={asset.id}
            // Assets are content-addressed and served immutable, so the disk
            // cache is free correctness: re-opening the library does not
            // re-download the page you were just looking at.
            cachePolicy="memory-disk"
            transition={120}
            onError={() => setPreviewFailed(true)}
            // The tile already carries the whole description; a second
            // accessible node here would announce the image twice.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ width: "100%", height: "100%" }}
          />
        ) : (
          <View style={{ alignItems: "center", gap: 4, paddingHorizontal: 8 }}>
            <Text
              {...typeCap("badge")}
              style={{
                color: t.fgMuted,
                ...typeStyle("badge"),
                fontFamily: FONT.semibold,
              }}
            >
              {format}
            </Text>
            <Text
              numberOfLines={2}
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                textAlign: "center",
              }}
            >
              Preview unavailable
            </Text>
          </View>
        )}
      </View>

      <View style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 4 }}>
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {asset.filename || "Untitled image"}
        </Text>
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("numeric")}
          style={{
            color: t.fgMuted,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
          }}
        >
          {dimensions ?? EMDASH} · {size}
        </Text>
        {inUse ? (
          <View style={{ flexDirection: "row" }}>
            <Pill
              label="In use"
              tone="info"
              accessibilityLabel={assetUsagePhrase(asset.referencesCount)}
            />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export const AssetTile = memo(AssetTileImpl);
