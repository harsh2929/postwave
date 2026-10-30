/**
 * AnalyticsChrome — the Analytics screen's header and closing footnote.
 *
 * Extracted from `app/(tabs)/analytics.tsx` by responsibility, not by size:
 * the screen file decides which SECTIONS exist and in what order, and these
 * two decide what frames them. Keeping them there put the screen against its
 * 450-line ceiling, where the next section could only be added by raising a
 * ratchet.
 *
 * Behaviour is unchanged from the versions that lived in the screen.
 */
import { Text } from "react-native";

import { ScreenHeader } from "@/components/ScreenHeader";
import { AnalyticsExportButton } from "@/components/analytics/AnalyticsExportButton";
import type { useAnalyticsScreen } from "@/hooks/useAnalyticsScreen";
import { ANALYTICS_FOOTNOTE } from "@/lib/analyticsScreenChrome";
import { FONT } from "@/lib/fonts";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The screen's closing caveat. The React half of `ANALYTICS_FOOTNOTE`: the
 * words live in lib/analyticsScreenChrome so they are assertable in the node
 * test environment, and only the styling stays here.
 */
export function AnalyticsFootnote() {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.regular,
        ...typeStyle("caption"),
        marginTop: 24,
      }}
    >
      {ANALYTICS_FOOTNOTE}
    </Text>
  );
}

/**
 * The screen header, extracted so the screen body stays inside its function
 * budget rather than growing a ratchet.
 *
 * The subtitle carries the window AND how old the numbers under it are: both
 * are part of the datum on a screen nobody polls.
 *
 * DASHBOARD#40 — the export button hides ITSELF when there is nothing to send
 * (offering to share an empty file is a broken promise), but stays PRESENT
 * when a section failed, because the file names what it could not include and
 * that is the fact a reader most needs. It is suppressed entirely while the
 * session is restricted: a screen that cannot read its own numbers must not
 * offer to export them.
 */
export function AnalyticsHeader({
  rangeLabel,
  freshness,
  exportPlan,
  restricted,
}: {
  rangeLabel: string;
  freshness: string | null;
  exportPlan: ReturnType<typeof useAnalyticsScreen>["exportPlan"];
  restricted: boolean;
}) {
  return (
    <ScreenHeader
      title="Analytics"
      subtitle={freshness ? `${rangeLabel} · ${freshness}` : rangeLabel}
      onBack={goBackOrMore}
      right={
        restricted ? undefined : (
          <AnalyticsExportButton
            rangeLabel={rangeLabel}
            series={exportPlan.series}
            unavailable={exportPlan.unavailable}
          />
        )
      }
    />
  );
}
