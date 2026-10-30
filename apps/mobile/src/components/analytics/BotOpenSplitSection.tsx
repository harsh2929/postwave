/**
 * BotOpenSplitSection — "how much of that open rate is machines?", asked on
 * the screen that shows the open rate.
 *
 * Deliverability already carries the full bot-opens card, signature editing
 * included (components/deliverability/BotOpensCard). This is the READ half,
 * placed next to the three rates and the human-engaged-reach floor it
 * qualifies — the register's own note is that ReachSection answers the
 * neighbouring question from a different endpoint, which is exactly why the
 * machine split belongs beside it rather than a tab away. Signature writes
 * stay on Deliverability (the register: "signature editing can stay desk"),
 * and the copy says so rather than leaving the reader hunting.
 *
 * ARMED BY A PRESS: the stats read regex-scans the tenant's open history, so
 * it must not fire because someone scrolled past. It shares its query key with
 * the Deliverability card, so a reader who already loaded it there pays
 * nothing here.
 *
 * NOT ONE NUMBER IS COMPUTED HERE. No percentage, no ratio, no rounding —
 * the server's counts, its window, and its signature labels, verbatim. See
 * lib/botOpenSplit for why.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { useBotOpenStats } from "@/hooks/useDeliverabilityBotOpens";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  BOT_OPEN_SPLIT_SIGNATURE_NOTE,
  BOT_OPEN_SPLIT_SUBTITLE,
  BOT_OPEN_SPLIT_UNAVAILABLE,
  botOpenSignatureLines,
  botOpenSignatureOverflow,
  botOpenSplitDiscrepancy,
  botOpenSplitHeadline,
  botOpenSplitWindow,
} from "@/lib/botOpenSplit";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TITLE = "Machine vs human opens";

function Line({
  text,
  tone = "muted",
  alert,
}: {
  text: string;
  tone?: "body" | "muted";
  alert?: boolean;
}) {
  const { t } = useTheme();
  if (!text) return null;
  const variant = tone === "body" ? "bodySmall" : "caption";
  return (
    <Text
      {...(alert ? { accessibilityRole: "alert" as const } : {})}
      {...typeCap(variant)}
      style={{
        color: alert ? t.warning : tone === "body" ? t.fg : t.fgSubtle,
        ...typeStyle(variant),
        fontFamily: tone === "body" ? FONT.medium : FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}

function BotOpenSplitBody() {
  const { t } = useTheme();
  const stats = useBotOpenStats(true);

  if (stats.isLoading) return <SkeletonCard />;
  if (stats.isError || !stats.data) {
    // The status-aware copy AND the clarification, because neither is enough
    // alone: ErrorState knows whether a retry can work, and only this card
    // knows that a reader who came here asking "how much of this is machines?"
    // will otherwise read a failed panel as an answer of none.
    return (
      <View style={{ marginTop: 8, gap: 6 }}>
        <ErrorState
          error={stats.error}
          onRetry={() => void stats.refetch()}
          compact
        />
        <Line text={BOT_OPEN_SPLIT_UNAVAILABLE} alert />
      </View>
    );
  }

  const data = stats.data;
  const lines = botOpenSignatureLines(data);
  const overflow = botOpenSignatureOverflow(data, lines.length);
  const discrepancy = botOpenSplitDiscrepancy(data);

  return (
    <View
      style={{
        marginTop: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.border,
        padding: 14,
        gap: 6,
      }}
    >
      <Line text={botOpenSplitHeadline(data)} tone="body" />
      <Line text={botOpenSplitWindow(data.since)} />
      {discrepancy ? <Line text={discrepancy} alert /> : null}
      {data.totalOpens > 0 && lines.length === 0 ? (
        <Line text="No open matched a detection signature in this window." />
      ) : null}
      {lines.length > 0 ? (
        <View style={{ gap: 4, marginTop: 4 }}>
          {lines.map((line) => (
            <View
              key={line.key}
              accessible
              accessibilityLabel={line.spoken}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <Text
                {...typeCap("caption")}
                numberOfLines={1}
                style={{
                  color: t.fg,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  flex: 1,
                }}
              >
                {line.label}
              </Text>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("caption"),
                  fontFamily: FONT.medium,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {line.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <Line text={overflow} />
      <Line text={BOT_OPEN_SPLIT_SIGNATURE_NOTE} />
    </View>
  );
}

export function BotOpenSplitSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [armed, setArmed] = useState(false);
  const offline = !gate.enabled;

  return (
    <View style={{ marginTop: 24 }}>
      <SectionLabel subtitle={BOT_OPEN_SPLIT_SUBTITLE}>{TITLE}</SectionLabel>
      {armed && !offline ? (
        <BotOpenSplitBody />
      ) : offline ? (
        <Line text="Open quality can't be read offline." />
      ) : (
        <Pressable
          onPress={() => {
            haptics.tap();
            setArmed(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Check how many opens were machines"
          accessibilityHint="Reads the server's machine and human open counts for the current signature set."
          hitSlop={8}
          style={{
            minHeight: 44,
            justifyContent: "center",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
            paddingHorizontal: 14,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            Check open quality
          </Text>
        </Pressable>
      )}
      {armed && !offline ? null : (
        // Said before the read as well as after it: a reader who cannot act on
        // the signature list here should learn that without paying for a scan.
        <View style={{ marginTop: 6 }}>
          <Line text={BOT_OPEN_SPLIT_SIGNATURE_NOTE} />
        </View>
      )}
    </View>
  );
}
