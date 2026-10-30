/**
 * OutboundWebhookSelectionBar — the bar that appears once endpoint rows are
 * selected on the Webhooks screen.
 *
 * Desktop puts pause/resume/delete in a toolbar above a table with a header
 * checkbox (pages/OutboundWebhooks.tsx). A phone has neither, so selection is
 * entered with a LONG PRESS on a row and left with Done — the iOS convention
 * the campaigns and subscribers lists already use — and the verbs live in a
 * bar pinned above the tab bar, inside thumb reach.
 *
 * The same four rules as CampaignSelectionBar, restated because they are the
 * ones a greyed-out toolbar breaks:
 *  - EVERY DISABLED VERB SAYS WHY (the sentence is rendered, and is the
 *    button's accessibilityHint).
 *  - PROGRESS IS VISIBLE: the fan-out is one round trip per endpoint, so the
 *    bar counts them off ("Pausing 3 of 12…") instead of freezing.
 *  - NOTHING IS COLOUR-ONLY: Delete carries the word and the danger tone.
 *  - THE COUNT IS THE TITLE, and it is announced as it changes.
 *
 * Its own component rather than CampaignSelectionBar reused: that bar's
 * accessibility label says "N campaigns selected", which a screen reader
 * would announce on a webhooks screen.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONT } from "@/lib/fonts";
import type { BulkWebhookVerb } from "@/lib/outboundWebhookSelection";
import { webhookSelectionTitle } from "@/lib/outboundWebhookSelection";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface WebhookBulkVerb {
  key: BulkWebhookVerb;
  label: string;
  onPress: () => void;
  /** Null when available; a full sentence when not. */
  blockedReason: string | null;
  destructive?: boolean;
}

export interface OutboundWebhookSelectionBarProps {
  count: number;
  verbs: readonly WebhookBulkVerb[];
  onDone: () => void;
  /** e.g. "Pausing 3 of 12…" — shown in place of the verbs while running. */
  busyLabel: string | null;
}

function VerbButton({
  verb,
  t,
  disabled,
}: {
  verb: WebhookBulkVerb;
  t: ThemeTokens;
  disabled: boolean;
}) {
  const blocked = verb.blockedReason !== null || disabled;
  return (
    <Pressable
      onPress={blocked ? undefined : verb.onPress}
      accessibilityRole="button"
      accessibilityLabel={verb.label}
      accessibilityState={{ disabled: blocked }}
      {...(verb.blockedReason ? { accessibilityHint: verb.blockedReason } : {})}
      disabled={blocked}
      style={{
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: verb.destructive ? t.danger : t.border,
        backgroundColor: t.surface,
        opacity: blocked ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: verb.destructive ? t.danger : t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {verb.label}
      </Text>
    </Pressable>
  );
}

export function OutboundWebhookSelectionBar({
  count,
  verbs,
  onDone,
  busyLabel,
}: OutboundWebhookSelectionBarProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  // One sentence carries the message; three near-identical ones would be noise.
  const reason = verbs.find((v) => v.blockedReason !== null)?.blockedReason;

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel={`${webhookSelectionTitle(count)}. Bulk actions.`}
      style={{
        borderTopColor: t.border,
        borderTopWidth: 1,
        backgroundColor: t.surface,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: Math.max(insets.bottom, 10),
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("label")}
          accessibilityRole="header"
          accessibilityLiveRegion="polite"
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {busyLabel ?? webhookSelectionTitle(count)}
        </Text>
        <Pressable
          onPress={onDone}
          accessibilityRole="button"
          accessibilityLabel="Leave selection mode"
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontFamily: FONT.semibold,
            }}
          >
            Done
          </Text>
        </Pressable>
      </View>

      {busyLabel ? null : (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {verbs.map((verb) => (
            <VerbButton key={verb.key} verb={verb} t={t} disabled={false} />
          ))}
        </View>
      )}

      {!busyLabel && reason ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {reason}
        </Text>
      ) : null}
    </View>
  );
}
