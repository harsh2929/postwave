/**
 * AssetUsageBlock — "what would break if this image went away".
 *
 * Four states, and the difference between them is the whole reason this block
 * exists as its own component rather than a ternary in the sheet:
 *
 *   NOT READ YET  → "Checking what uses this…". The grid row carries a
 *                   periodically refreshed `references_count` scalar and no
 *                   names at all; only `GET /assets/{id}` recomputes the
 *                   referrer LIST (handlers.go:360).
 *   FAILED        → says the check failed. It must NOT collapse into "nothing
 *                   uses this", which is the single most dangerous sentence
 *                   this screen could print before a delete.
 *   LOADED, EMPTY → genuinely unreferenced, and safe to say so.
 *   LOADED, N     → the names, so the operator recognises the campaign.
 *
 * `Referrer.Kind` is one of "campaign" | "template" | "form" (repo.go:63) and is
 * shown in words, because "form" and "campaign" are not interchangeable when
 * you are deciding whether to break one.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { AssetReferrer } from "@/lib/assetLibrary";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AssetUsageBlockProps {
  usage: readonly AssetReferrer[];
  loading: boolean;
  failed: boolean;
  /** True once the single read has produced a payload at all. */
  loaded: boolean;
}

const KIND_LABELS: Record<string, string> = {
  campaign: "Campaign",
  template: "Template",
  form: "Form",
};

export function referrerKindLabel(kind: string): string {
  const key = (kind || "").trim().toLowerCase();
  return KIND_LABELS[key] ?? (key ? key : "Item");
}

export function AssetUsageBlock({
  usage,
  loading,
  failed,
  loaded,
}: AssetUsageBlockProps) {
  const { t } = useTheme();

  const heading = (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.semibold,
        letterSpacing: 0.6,
      }}
    >
      USED BY
    </Text>
  );

  const body = failed ? (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.warning,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      Couldn&apos;t check what uses this image. Don&apos;t read that as
      &ldquo;nothing&rdquo; — try again before deciding anything.
    </Text>
  ) : !loaded ? (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {loading ? "Checking what uses this…" : "Not checked yet."}
    </Text>
  ) : usage.length === 0 ? (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      Nothing live uses this image right now.
    </Text>
  ) : (
    <View style={{ gap: 6 }}>
      {usage.map((referrer, index) => (
        <View
          key={`${referrer.kind}-${referrer.id}-${index}`}
          accessible
          accessibilityLabel={`${referrerKindLabel(referrer.kind)}: ${referrer.name || "Untitled"}`}
          style={{
            flexDirection: "row",
            gap: 8,
            alignItems: "baseline",
          }}
        >
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("badgeSmall"),
              fontFamily: FONT.semibold,
              minWidth: 72,
            }}
          >
            {referrerKindLabel(referrer.kind)}
          </Text>
          <Text
            numberOfLines={2}
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              flex: 1,
            }}
          >
            {referrer.name || "Untitled"}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={{ gap: 6 }}>
      {heading}
      {body}
    </View>
  );
}
