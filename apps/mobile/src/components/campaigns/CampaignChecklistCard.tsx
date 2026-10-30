/**
 * CampaignChecklistCard — the six pre-send gates, on the phone.
 *
 * The backend has always computed them (apps/api/internal/campaigns/
 * checklist.go: from-address verified, subject set, body non-empty, list
 * selected, recipients > 0, unsubscribe link present) and desktop has always
 * shown them. Mobile's send sheet was a paragraph of copy and a placement
 * predictor — you could send to a whole list from a phone with no
 * verification that the campaign even had an unsubscribe link.
 *
 * Every row carries a glyph as well as a colour, because a pass/fail state
 * that is only expressed as a hue is invisible to a colour-blind operator.
 */
import { ActivityIndicator, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { checklistGlyph, checklistTone } from "@/lib/campaignChecklist";
import type { ChecklistSummary } from "@/lib/campaignChecklist";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface CampaignChecklistCardProps {
  summary: ChecklistSummary | null | undefined;
  loading: boolean;
  error: unknown;
}

export function CampaignChecklistCard({
  summary,
  loading,
  error,
}: CampaignChecklistCardProps) {
  const { t } = useTheme();

  const container = {
    backgroundColor: t.surface,
    borderColor: t.borderSubtle,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  } as const;

  if (loading) {
    return (
      <View style={container} accessibilityLabel="Running pre-send checks">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color={t.fgMuted} />
          <Text
            {...typeCap("bodySmall")}
            style={{ color: t.fgMuted, fontSize: 13, fontFamily: FONT.regular }}
          >
            Running pre-send checks…
          </Text>
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={container} accessibilityLabel="Pre-send checks unavailable">
        <Text
          {...typeCap("bodySmall")}
          style={{ color: t.warning, fontSize: 13, fontFamily: FONT.semibold }}
        >
          Pre-send checks didn&apos;t load
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            fontSize: 12,
            marginTop: 4,
            lineHeight: 17,
            fontFamily: FONT.regular,
          }}
        >
          {campaignErrorMessage(error, "Couldn't run the pre-send checks.")}
        </Text>
      </View>
    );
  }

  if (!summary || summary.items.length === 0) {
    return (
      <View style={container} accessibilityLabel="Pre-send checks unavailable">
        <Text
          {...typeCap("label")}
          style={{ color: t.fgMuted, fontSize: 12, fontFamily: FONT.regular }}
        >
          Pre-send checks aren&apos;t available for this campaign. Review it on
          the web app before sending.
        </Text>
      </View>
    );
  }

  const headlineColor =
    summary.failCount > 0
      ? t.danger
      : summary.warnCount > 0
        ? t.warning
        : t.success;

  return (
    <View style={container}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          accessibilityRole="header"
          style={{
            color: headlineColor,
            fontSize: 13,
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {summary.headline}
        </Text>
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {summary.passCount}/{summary.items.length}
        </Text>
      </View>

      <View style={{ marginTop: 8, gap: 8 }}>
        {summary.items.map((item) => (
          <View
            key={item.key}
            accessible
            accessibilityLabel={`${item.label}: ${item.status === "pass" ? "passed" : item.status === "fail" ? "failed" : "warning"}${item.detail ? `. ${item.detail}` : ""}`}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
          >
            <Pill
              label={`${checklistGlyph(item.status)} ${item.status}`}
              tone={checklistTone(item.status)}
            />
            <View style={{ flex: 1 }}>
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fg,
                  fontSize: 12,
                  fontFamily: FONT.medium,
                }}
              >
                {item.label}
              </Text>
              {item.detail ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    fontSize: 11,
                    lineHeight: 15,
                    marginTop: 1,
                    fontFamily: FONT.regular,
                  }}
                >
                  {item.detail}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
