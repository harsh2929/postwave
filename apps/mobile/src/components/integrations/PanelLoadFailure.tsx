/**
 * PanelLoadFailure — what a self-hiding integrations panel renders when its
 * read FAILED rather than came back empty.
 *
 * THE BUG THIS CLOSES. Each panel on the integrations screen is written to
 * disappear when it has no rows — correct, because a workspace with no CRM
 * connection should not be shown an empty "CRM connections" heading. But every
 * one of them derived "no rows" from `query.data ?? []`, which is also what a
 * FAILED fetch produces. So a 500 on `/api/v1/integrations/salesforce` removed
 * the whole section from the screen, and an operator who came to check whether
 * a sync was paused read the absence as an answer: there are none.
 *
 * That is the same lie `QueryStates` exists to prevent one level up, in its
 * quietest form — the screen does not say "no CRM connections", it says
 * nothing at all, and nothing at all is read as none.
 *
 * The panels keep their empty-hide; they now branch on `isError` FIRST and
 * render this instead, so a failed read stays visible and is nameable.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface PanelLoadFailureProps {
  /** The section heading this panel would have rendered. */
  title: string;
  /**
   * What could not be read, as a noun phrase — "CRM connections". Used in the
   * sentence so the failure names the thing rather than saying "this section".
   */
  subject: string;
}

export function PanelLoadFailure({ title, subject }: PanelLoadFailureProps) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 6, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {title}
      </Text>
      <Text
        accessibilityRole="alert"
        {...typeCap("caption")}
        style={{
          color: t.warning,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {`Couldn't load ${subject}. Pull to refresh — this is not the same as having none.`}
      </Text>
    </View>
  );
}
