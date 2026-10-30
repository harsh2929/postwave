/**
 * CampaignRegionBranchToggles — preview ANY branch combination, without
 * naming a subscriber.
 *
 * Preview-as answers "what does THIS person get?"; it cannot answer "what
 * does the false branch of `is_vip` look like?" when no current subscriber
 * happens to hit it. Desktop's DynamicContentPanel resolves combinations
 * client-side over the region byte offsets; lib/campaignRegionPicks is the
 * pure port (including the UTF-8→UTF-16 offset map), and this renders it.
 *
 * Client-side only — the region list is the same GET /campaigns/{id}/regions
 * (viewer) the sheet already reads, so this stays available to the reviewer
 * who cannot change anything.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";

import { SegmentedControl } from "@/components/SegmentedControl";
import { Card } from "@/components/campaigns/CampaignDetailControls";
import { htmlToText } from "@/lib/campaignBody";
import {
  applyRegionPicks,
  pickableRegions,
  type RegionBranchPick,
} from "@/lib/campaignRegionPicks";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const RESOLVED_CHARS = 4000;

const PICK_OPTIONS: readonly { value: RegionBranchPick; label: string }[] = [
  { value: "true", label: "True" },
  { value: "false", label: "False" },
  { value: "default", label: "Raw" },
];

export function CampaignRegionBranchToggles({
  bodyHtml,
  regionsResponse,
}: {
  /** The SAVED body — the only thing substitution ever runs against. */
  bodyHtml: string;
  regionsResponse: { regions?: unknown } | null | undefined;
}) {
  const { t } = useTheme();
  const regions = useMemo(
    () => pickableRegions(regionsResponse),
    [regionsResponse],
  );
  const [picks, setPicks] = useState<Record<string, RegionBranchPick>>({});

  const anyPicked = Object.values(picks).some((p) => p !== "default");
  const resolved = useMemo(
    () =>
      anyPicked
        ? htmlToText(applyRegionPicks(bodyHtml, regions, picks), RESOLVED_CHARS)
        : null,
    [anyPicked, bodyHtml, picks, regions],
  );

  if (regions.length === 0 || bodyHtml.trim() === "") return null;

  return (
    <View style={{ marginTop: 16 }}>
      <Text
        {...typeCap("caption")}
        accessibilityRole="header"
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.6,
          textTransform: "uppercase",
          fontWeight: "600",
          fontFamily: FONT.semibold,
          marginBottom: 8,
        }}
      >
        Try a branch combination
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginBottom: 8,
        }}
      >
        Pick a side per region to see a version no current subscriber may
        happen to hit. &ldquo;False&rdquo; on a region with no else branch
        collapses it to nothing — that recipient receives nothing there.
      </Text>
      <View style={{ gap: 10 }}>
        {regions.map((region) => (
          <View key={region.key} style={{ gap: 4 }}>
            <Text
              {...typeCap("mono")}
              style={{
                color: t.fg,
                ...typeStyle("mono"),
                fontFamily: FONT.medium,
              }}
            >
              {region.key}
            </Text>
            <SegmentedControl<RegionBranchPick>
              options={PICK_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              value={picks[region.key] ?? "default"}
              onChange={(next) =>
                setPicks((prev) => ({ ...prev, [region.key]: next }))
              }
              accessibilityLabel={`Branch for region ${region.key}`}
            />
          </View>
        ))}
      </View>
      {resolved !== null ? (
        <View style={{ marginTop: 10 }}>
          <Card>
            <Text
              {...typeCap("bodySmall")}
              selectable
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                writingDirection: "auto",
              }}
            >
              {resolved || "This combination resolves to an empty body."}
            </Text>
          </Card>
        </View>
      ) : null}
    </View>
  );
}
