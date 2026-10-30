/**
 * CampaignReplyIntentFilter — narrow a big reply thread to one intent.
 *
 * The chip row reuses the exact vocabulary the classify verb writes
 * (lib/campaignReplyIntents ← lib/replyClassification REPLY_INTENTS), with
 * counts from the UNFILTERED response's intent_counts. Tapping a chip
 * re-reads the id-bearing list with `?intent=` — the narrowing is the
 * server's answer. Viewer-scope throughout.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useCampaignReplyIntents } from "@/hooks/useCampaignReplyIntents";
import { replyIntentChips } from "@/lib/campaignReplyIntents";
import type { ReplyIntent } from "@/lib/replyClassification";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignReplyIntentFilter({
  campaignId,
  enabled,
}: {
  campaignId: string;
  /** The hosting card's expanded state — no fetch while collapsed. */
  enabled: boolean;
}) {
  const { t } = useTheme();
  const [intent, setIntent] = useState<ReplyIntent | null>(null);
  // The unfiltered read carries the counts; the filtered read the rows.
  const all = useCampaignReplyIntents(campaignId, null, { enabled });
  const filtered = useCampaignReplyIntents(campaignId, intent, {
    enabled: enabled && intent !== null,
  });

  const chips = replyIntentChips(all.data?.counts ?? {}, all.data?.total ?? null);
  const shown = intent === null ? all.data : filtered.data;
  const loading = intent === null ? all.isLoading : filtered.isLoading;

  return (
    <View style={{ marginTop: 14, gap: 8 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Filter by intent
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {chips.map((chip) => {
          const active =
            chip.intent === intent || (chip.intent === null && intent === null);
          return (
            <Pressable
              key={chip.intent ?? "all"}
              onPress={() => {
                haptics.tap();
                setIntent(chip.intent);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Show ${chip.label} replies${
                chip.count !== null ? `, ${chip.count}` : ""
              }`}
              accessibilityState={{ selected: active }}
              style={{
                borderColor: active ? t.accent : t.border,
                backgroundColor: active ? t.accent : t.bgSubtle,
                borderWidth: 1,
                borderRadius: 999,
                paddingHorizontal: 12,
                minHeight: 32,
                justifyContent: "center",
              }}
            >
              <Text
                {...typeCap("caption")}
                style={{
                  color: active ? t.accentFg : t.fg,
                  ...typeStyle("caption"),
                  fontFamily: FONT.medium,
                }}
              >
                {chip.label}
                {chip.count !== null ? ` ${chip.count}` : ""}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {intent !== null ? (
        loading ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Narrowing…
          </Text>
        ) : shown && shown.rows.length > 0 ? (
          <View style={{ gap: 8 }}>
            {shown.rows.map((row) => (
              <View
                key={row.id}
                style={{
                  borderTopColor: t.borderSubtle,
                  borderTopWidth: 1,
                  paddingTop: 8,
                  gap: 2,
                }}
              >
                <Text
                  {...typeCap("bodySmall")}
                  numberOfLines={1}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  {row.subject}
                </Text>
                <Text
                  {...typeCap("caption")}
                  numberOfLines={1}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {row.fromEmail}
                  {row.receivedAt ? ` · ${row.receivedAt}` : ""}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            No replies carry this intent yet.
          </Text>
        )
      ) : null}
    </View>
  );
}
