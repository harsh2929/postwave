/** Compact P2.4 status inside the final send sheet. The server remains authority. */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { Card } from "@/components/campaigns/CampaignDetailControls";
import { useCampaignAssuranceStatus } from "@/hooks/useCampaignAssurance";
import {
  mobileAssuranceVerdict,
  shortAssuranceHash,
} from "@/lib/campaignAssurance";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignAssuranceSendStatus({
  campaignId,
  visible,
}: {
  campaignId: string;
  visible: boolean;
}) {
  const { t } = useTheme();
  const query = useCampaignAssuranceStatus(campaignId, { enabled: visible });
  const latest = query.data?.data;
  const verdict = latest ? mobileAssuranceVerdict(latest) : null;
  const run = latest?.detail.run;
  return (
    <Card accessibilityLabel="Unified Campaign Assurance pre-send status">
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("callout")}
            accessibilityRole="header"
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontFamily: FONT.semibold,
            }}
          >
            Unified pre-send assurance
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 2,
            }}
          >
            Predicted Agent Comprehension for the exact frozen send.
          </Text>
        </View>
        {verdict ? (
          <Pill label={verdict.label} tone={verdict.tone} />
        ) : query.isError ? (
          <Pill label="Unavailable" tone="warning" />
        ) : query.isLoading ? (
          <Pill label="Checking" tone="neutral" />
        ) : (
          <Pill label="No receipt" tone="warning" />
        )}
      </View>

      <Text
        {...typeCap("bodySmall")}
        accessibilityRole={verdict?.tone === "danger" ? "alert" : undefined}
        style={{
          color: verdict?.tone === "danger" ? t.danger : t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginTop: 8,
        }}
      >
        {query.isLoading
          ? "Checking the exact Campaign Assurance receipt…"
          : query.isError
            ? "Campaign Assurance could not be loaded. This is not a passing result."
            : verdict
              ? verdict.detail
              : "No Campaign Assurance receipt is available. The queue may refuse this send."}
      </Text>

      {run && latest ? (
        <View style={{ marginTop: 8, gap: 3 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Predicted score {run.overall_score ?? "unavailable"} ·{" "}
            {run.blocking_finding_count} blocker(s) · freshness{" "}
            {latest.applicability.freshness}
          </Text>
          <Text
            selectable
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: "monospace",
            }}
          >
            Source {shortAssuranceHash(run.source_hash)} · Plan{" "}
            {shortAssuranceHash(run.plan_hash)} · Artifacts{" "}
            {shortAssuranceHash(run.artifact_set_hash)}
          </Text>
        </View>
      ) : null}

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 8,
        }}
      >
        This preview never authorizes a send. The queue rechecks the exact
        revision, plan, artifacts, findings, and governed waivers and may refuse
        this action.
      </Text>
    </Card>
  );
}
