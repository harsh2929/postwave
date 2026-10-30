/**
 * GpcSignalsCard — are GPC opt-out signals arriving, and do they correlate?
 *
 * Sits beside SarQueueBanner on the compliance screen and follows its
 * philosophy: render only when there is something to say. Zero GPC signals
 * in the window renders NOTHING — an "all clear" card on a compliance
 * screen trains people to skip the region where the real warning will
 * eventually appear. What it must never do is let a failed read look like
 * that silence, so a query error renders its own line — and a live 403
 * reads as the permission rule it is, not as a generic fault.
 *
 * The numbers are derived from the loaded page of the admin event feed
 * (the same derivation desktop's Consent masthead performs) and the card
 * says so: a page is a floor, not the ledger.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { isConsentReadDenied } from "@/api/consentEvents";
import { useGpcSignals } from "@/hooks/useGpcSignals";
import { FONT } from "@/lib/fonts";
import {
  GPC_DENIED_COPY,
  GPC_SCOPE_NOTE,
  gpcHeadline,
  gpcUncorrelatedNotice,
} from "@/lib/gpcSignals";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function GpcSignalsCard() {
  const { t } = useTheme();
  const { mayRead, query } = useGpcSignals();

  // Below admin the affordance is omitted entirely; the host screen's own
  // role notice already explains the boundary once for the whole surface.
  if (!mayRead) return null;

  if (query.isError) {
    const denied = isConsentReadDenied(query.error);
    return (
      <Shell t={t}>
        <Text
          {...typeCap("caption")}
          style={{
            color: denied ? t.fgMuted : t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {denied
            ? GPC_DENIED_COPY
            : `Couldn't load GPC signals. ${
                query.error instanceof Error ? query.error.message : ""
              }`.trim()}
        </Text>
      </Shell>
    );
  }

  const summary = query.data;
  // Loading, offline, or a clean window with nothing to warn about.
  if (!summary || summary.signalRows === 0) return null;

  const uncorrelated = gpcUncorrelatedNotice(summary);
  return (
    <Shell t={t}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 6,
        }}
      >
        {gpcHeadline(summary)}
      </Text>
      {uncorrelated ? (
        <Text
          // Signals that cannot be honoured against a person are the fact
          // this card exists to surface — announced on arrival.
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {uncorrelated}
        </Text>
      ) : null}
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginTop: 6,
        }}
      >
        {GPC_SCOPE_NOTE}
      </Text>
    </Shell>
  );
}

/** The banner chrome shared with SarQueueBanner: kicker + card. */
function Shell({
  children,
  t,
}: {
  children: React.ReactNode;
  t: ThemeTokens;
}) {
  return (
    <View style={{ marginTop: 12 }}>
      <Card>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Global Privacy Control
        </Text>
        {children}
      </Card>
    </View>
  );
}
