/**
 * CampaignHonestEngagementBody — the render half of the "Honest engagement"
 * insight card on the campaign detail screen (desktop twin:
 * components/analytics/EngagementPanel.tsx).
 *
 * Nothing here fetches or interprets. It lays out a HonestEngagementView from
 * lib/campaignHonestEngagement, where every honesty rule — no human row when
 * bot-filtering is off, no rate without a denominator, no AI number on a
 * sample the server distrusts — is node-tested.
 *
 * A null view is a 2xx the reader rejected — the response-shape-drift class
 * that turns into silently-empty screens — and is named as such rather than
 * rendered as a blank card.
 *
 * Two things are fixed in the markup rather than the data: the AI-surfacing
 * block carries its "Estimate" pill in the header unconditionally (desktop's
 * EstimateBadge rule — the score can never render as fact), and every stat
 * row is read to a screen reader WITH its qualifier, because the qualifier
 * is what makes the number true.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { StatRow } from "@/components/campaigns/CampaignDetailControls";
import type { HonestEngagementView } from "@/lib/campaignHonestEngagement";
import { FONT } from "@/lib/fonts";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

function Caption({ text, t }: { text: string; t: ThemeTokens }) {
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        fontSize: 10,
        lineHeight: 14,
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}

export function CampaignHonestEngagementBody({
  view,
  t,
}: {
  view: HonestEngagementView | null;
  t: ThemeTokens;
}) {
  if (!view) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{ color: t.fgMuted, fontSize: 12, fontFamily: FONT.regular }}
      >
        The engagement panel answered in a shape this app can&apos;t read, so
        nothing is shown rather than a guess.
      </Text>
    );
  }
  const ai = view.aiSurfacing;
  return (
    <View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fg,
          fontSize: 12,
          lineHeight: 17,
          marginBottom: 8,
          fontFamily: FONT.medium,
        }}
      >
        {view.headline}
      </Text>

      {view.rows.map((row, i) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={`${row.label}: ${row.value}. ${row.detail}`}
        >
          <StatRow
            label={row.label}
            value={row.value}
            t={t}
            last={i === view.rows.length - 1}
          />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontSize: 10,
              lineHeight: 14,
              marginTop: -6,
              marginBottom: 6,
              fontFamily: FONT.regular,
            }}
          >
            {row.detail}
          </Text>
        </View>
      ))}

      {view.notes.length > 0 ? (
        <View style={{ gap: 4, marginTop: 4 }}>
          {view.notes.map((note) => (
            <Caption key={note} text={note} t={t} />
          ))}
        </View>
      ) : null}

      {ai ? (
        <View
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            marginTop: 12,
            paddingTop: 10,
            gap: 4,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              {...typeCap("label")}
              style={{ color: t.fg, fontSize: 12, fontFamily: FONT.medium }}
            >
              AI-surfacing estimate
            </Text>
            <Pill label="Estimate" tone="info" />
          </View>
          {ai.kind === "scored" ? (
            <View
              accessible
              accessibilityLabel={`AI-surfacing estimate ${ai.bucket}, ${ai.score}, ${ai.confidence} confidence, ${ai.sample}`}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{ color: t.fg, fontSize: 13, fontFamily: FONT.semibold }}
              >
                {`${ai.bucket} · ${ai.score}`}
              </Text>
              <Caption text={`${ai.sample} · ${ai.confidence} confidence`} t={t} />
            </View>
          ) : (
            <Text
              {...typeCap("bodySmall")}
              style={{ color: t.fgMuted, fontSize: 12, fontFamily: FONT.regular }}
            >
              {ai.reason}
            </Text>
          )}
          {ai.basis ? <Caption text={ai.basis} t={t} /> : null}
        </View>
      ) : null}
    </View>
  );
}
