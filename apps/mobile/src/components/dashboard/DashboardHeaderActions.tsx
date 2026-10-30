/**
 * DashboardHeaderActions — the dashboard header's share action.
 *
 * The share affordance is GATED on a complete snapshot rather than always
 * present-but-broken. `canBuildDashboardSnapshot` requires every recipient
 * count the rates are derived from, so a workspace whose payload cannot
 * produce honest numbers simply has no share button — pasting a wall of
 * em-dashes into a team channel is worse than not offering to.
 *
 * IT USED TO CLIP TO "Shaı". ScreenHeader's right slot is `flexShrink: 1` with
 * `maxWidth: "58%"`, so at the largest Dynamic Type sizes the slot is clamped
 * while this button — the default `flexShrink: 0` — refused to yield. The
 * label overflowed the clamp, ran off the trailing screen edge, and was cut
 * mid-glyph; "Share" is a single word, so it could not wrap out of the problem
 * either. Observed on device at accessibility-extra-extra-extra-large.
 *
 * The fix is the two halves together, and both are load-bearing:
 *   - the button SHRINKS (`flexShrink: 1`), bounded below by the 44pt
 *     `minWidth` — so the tap target is preserved by construction, not by
 *     hoping the row never runs out of space;
 *   - the label SHRINKS TO FIT inside whatever width that leaves
 *     (`numberOfLines={1}` + `adjustsFontSizeToFit`), which is the same idiom
 *     StatCard and SinkMetrics use, and it takes `fontSizeFor` rather than the
 *     full `typeStyle` because an explicit leading fights the shrink pass.
 * The `accessibilityLabel` is untouched: a shrunk or truncated glyph run must
 * never shrink what VoiceOver says.
 */
import { useState } from "react";
import { Pressable, Share, Text } from "react-native";

import type { DashboardStats } from "@/hooks/useDashboard";
import {
  buildDashboardSnapshot,
  canBuildDashboardSnapshot,
} from "@/lib/dashboardSnapshot";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap } from "@/lib/typeScale";

export interface DashboardHeaderActionsProps {
  stats: DashboardStats | undefined;
  workspaceName: string | undefined;
  rangeLabel: string;
}

export function DashboardHeaderActions({
  stats,
  workspaceName,
  rangeLabel,
}: DashboardHeaderActionsProps) {
  const { t } = useTheme();
  const shareable = canBuildDashboardSnapshot(stats);
  const [pressed, setPressed] = useState(false);

  const onShare = () => {
    if (!canBuildDashboardSnapshot(stats)) return;
    haptics.tap();
    void Share.share({
      message: buildDashboardSnapshot(stats, {
        workspace: workspaceName,
        rangeLabel,
      }),
    });
  };

  if (!shareable) return null;

  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={onShare}
      accessibilityRole="button"
      accessibilityLabel={`Share a workspace snapshot for ${rangeLabel}`}
      hitSlop={8}
      android_ripple={{ color: t.borderSubtle, borderless: false }}
      // NativeWind v4: static style object only.
      style={{
        minHeight: 44,
        // The floor, and the reason shrinking is safe: flex never takes a box
        // below its `minWidth`, so the 44pt target survives the squeeze.
        minWidth: 44,
        // Yield width to the clamped header slot instead of overflowing past
        // the screen edge. This is the half of the clipping fix that lives in
        // the layout; the label owns the other half.
        flexShrink: 1,
        paddingHorizontal: 8,
        borderRadius: 10,
        backgroundColor: pressed ? t.accentSubtle : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        // `control`: this shares the header row with the title and search and
        // cannot reflow around either. The cap (1.4x) bounds how big it gets;
        // `adjustsFontSizeToFit` bounds how big it may STAY once the row has
        // run out of width for it.
        {...typeCap("control")}
        style={{
          color: t.accent,
          // `fontSizeFor`, not `typeStyle`: a fixed `lineHeight` fights the
          // shrink-to-fit pass.
          fontSize: fontSizeFor("control"),
          fontFamily: FONT.bold,
          fontWeight: "700",
          flexShrink: 1,
        }}
        numberOfLines={1}
        adjustsFontSizeToFit
        // "Share" at the 44pt floor still has ~28pt of inner width; 0.7 is
        // enough for the whole word and stays legible.
        minimumFontScale={0.7}
      >
        Share
      </Text>
    </Pressable>
  );
}
