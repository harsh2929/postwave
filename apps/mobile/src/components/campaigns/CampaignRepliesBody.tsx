/**
 * CampaignRepliesBody — the inbound replies to one send, newest first.
 *
 * The most phone-native shape left on this screen: a chronological list of
 * short human text. Reading replies is exactly the ambient checking people do
 * away from a desk, and until now mobile could show that 14 people replied and
 * not one word of what they said.
 *
 * Two decisions worth stating:
 *
 *  - THE RATE LEADS, THE FEED FOLLOWS. Three replies out of 50 recipients and
 *    three out of 50,000 are different events, so the denominator sits above
 *    the feed and is spoken in full (`replyRateSpoken`) rather than left as a
 *    bare percentage a screen reader cannot contextualise.
 *  - READ-ONLY, ON PURPOSE. Desktop can classify a reply's intent; the rows
 *    this endpoint returns carry no id (reply_analytics.go:174-180), so there
 *    is nothing to name to the classify endpoint. That is a server-side gap,
 *    and inventing a local identifier to paper over it would send a
 *    classification to the wrong reply.
 *
 * Pure render: the interpretation lives in lib/campaignReplies, where it is
 * testable in the node environment.
 */
import { Text, View } from "react-native";

import { StatRow } from "@/components/campaigns/CampaignDetailControls";
import type { CampaignRepliesReading } from "@/lib/campaignReplies";
import { replyRateSpoken } from "@/lib/campaignReplies";
import { FONT } from "@/lib/fonts";
import { num, relativeTime } from "@/lib/format";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignRepliesBody({
  reading,
  t,
}: {
  reading: CampaignRepliesReading;
  t: ThemeTokens;
}) {
  return (
    <View>
      <View accessible accessibilityLabel={replyRateSpoken(reading)}>
        <StatRow
          label="Replies"
          value={num(reading.replies)}
          t={t}
        />
        <StatRow
          label="Recipients who replied"
          value={`${num(reading.distinctReplyers)} of ${num(reading.uniqueRecipients)}`}
          t={t}
        />
        <StatRow
          label="Reply rate"
          value={`${reading.replyRatePercent.toFixed(1)}%`}
          t={t}
          last
        />
      </View>

      {reading.rows.length > 0 ? (
        <View style={{ gap: 10, marginTop: 12 }}>
          {reading.rows.map((row) => (
            <View
              key={row.key}
              accessible
              accessibilityLabel={[
                row.email || "Unknown sender",
                row.receivedAt != null ? relativeTime(row.receivedAt) : null,
                row.subject || null,
                row.snippet || null,
              ]
                .filter(Boolean)
                .join(". ")}
              style={{
                borderColor: t.borderSubtle,
                borderWidth: 1,
                borderRadius: 10,
                paddingHorizontal: 10,
                paddingVertical: 8,
                gap: 2,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <Text
                  {...typeCap("bodySmall")}
                  numberOfLines={1}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.semibold,
                    flex: 1,
                  }}
                >
                  {row.email || "Unknown sender"}
                </Text>
                {row.receivedAt != null ? (
                  <Text
                    {...typeCap("numeric")}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("numeric"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {relativeTime(row.receivedAt)}
                  </Text>
                ) : null}
              </View>

              {row.subject ? (
                <Text
                  {...typeCap("label")}
                  numberOfLines={1}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("label"),
                    fontFamily: FONT.medium,
                    writingDirection: "auto",
                  }}
                >
                  {row.subject}
                </Text>
              ) : null}

              {row.snippet ? (
                <Text
                  {...typeCap("bodySmall")}
                  numberOfLines={4}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                    // Replies are recipient-authored text in whatever script
                    // the recipient writes in.
                    writingDirection: "auto",
                  }}
                >
                  {row.snippet}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {reading.truncated ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          Showing the {reading.rows.length} most recent replies of{" "}
          {num(reading.replies)}. Open the web app for the full thread.
        </Text>
      ) : null}
    </View>
  );
}
