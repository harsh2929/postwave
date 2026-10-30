/**
 * CampaignPlacementCard — where a sent campaign actually landed, plus the
 * one-tap LLM diagnosis of why.
 *
 * Both reads ride the admin-scoped proxied services, so the card mounts only
 * for admins. The operator picks one of the recent SENT campaigns (placement
 * only exists after a send); the seed placement report loads for the pick,
 * and Diagnose gathers evidence first — desktop's DiagnosticianCard rule:
 * with NO verified auth or placement signal the AI request is never sent,
 * because a model diagnosing from nothing produces confident fiction.
 *
 * Three distinct empty states, never collapsed: 404 → "no seed test has
 * reported" (a real answer), 502/503 → "service not configured here", other
 * errors → a failure.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { SegmentedControl } from "@/components/SegmentedControl";
import { isServiceUnavailable } from "@/api/deliverabilityEvidence";
import {
  useDiagnoseCampaign,
  usePlacementReport,
} from "@/hooks/useDeliverabilityEvidence";
import { useCampaignsList } from "@/hooks/useCampaigns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import {
  placementRows,
  placementTone,
  splitDiagnosisSections,
} from "@/lib/deliverabilityOpsView";
import { forwardArrow } from "@/lib/direction";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { percent } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignPlacementCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [campaignId, setCampaignId] = useState("");
  const campaigns = useCampaignsList();
  const placement = usePlacementReport(campaignId);
  const diagnose = useDiagnoseCampaign();

  // Both proxied services are admin-floor; omit the surface below that.
  if (!isAdminRole(gate.effectiveRole)) return null;
  const offline = !gate.enabled;

  const sent = (Array.isArray(campaigns.data) ? campaigns.data : []).filter(
    (campaign) => Boolean(campaign.sent_at) || campaign.status === "sent",
  );

  const report = placement.data;

  return (
    <OpsCard>
      <OpsCardTitle>Where it landed</OpsCardTitle>
      <OpsCardBody>
        Seed-inbox placement for a sent campaign, and an AI diagnosis of what
        held it back.
      </OpsCardBody>
      {offline ? (
        <OpsCardBody>Placement evidence can&apos;t be read offline.</OpsCardBody>
      ) : sent.length === 0 ? (
        <OpsCardBody>
          {campaigns.isError
            ? "Recent campaigns couldn't be loaded."
            : "No recently sent campaigns to inspect."}
        </OpsCardBody>
      ) : (
        <SegmentedControl
          options={sent.map((campaign) => ({
            value: campaign.id,
            label: campaign.name || campaign.subject || campaign.id.slice(0, 8),
          }))}
          value={campaignId}
          onChange={setCampaignId}
          accessibilityLabel="Sent campaign to inspect"
          scrollable
        />
      )}
      {campaignId && !offline ? (
        placement.isError ? (
          <OpsCardBody role="alert">
            {isServiceUnavailable(placement.error)
              ? "The placement service isn't configured on this deployment."
              : "The placement report couldn't be loaded."}
          </OpsCardBody>
        ) : placement.isPending ? (
          <OpsCardBody>Loading the placement report…</OpsCardBody>
        ) : report === null ? (
          <OpsCardBody>
            No seed test has reported for this campaign — run one from the inbox
            tests panel above.
          </OpsCardBody>
        ) : report ? (
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {placementRows(report.overallPct).map((row) => (
                <Pill
                  key={row.code}
                  label={`${row.label} ${percent(row.fraction, { digits: 0 })}`}
                  tone={placementTone(row.code)}
                />
              ))}
            </View>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {`Across ${report.totalInboxes} seed inbox${report.totalInboxes === 1 ? "" : "es"}${report.providers.length ? ` · ${report.providers.length} providers` : ""}`}
            </Text>
          </View>
        ) : null
      ) : null}
      {campaignId && !offline ? (
        <OpsAction
          label={diagnose.isPending ? "Diagnosing…" : "Diagnose with AI"}
          onPress={() => {
            haptics.tap();
            diagnose.mutate(campaignId);
          }}
          disabled={diagnose.isPending}
        />
      ) : null}
      {diagnose.isError ? (
        <OpsCardBody role="alert">
          {errorPresentation(diagnose.error).message ||
            "The diagnosis could not be completed."}
        </OpsCardBody>
      ) : null}
      {diagnose.data && diagnose.data.campaignId === campaignId ? (
        <View style={{ gap: 6 }}>
          <OpsCardBody>
            {`Evidence used: ${[
              diagnose.data.evidence.authentication ? "authentication" : null,
              diagnose.data.evidence.placement ? "seed placement" : null,
            ]
              .filter(Boolean)
              .join(" + ")}.`}
          </OpsCardBody>
          {splitDiagnosisSections(diagnose.data.diagnosis)
            .slice(0, 4)
            .map((section, index) => (
              <View key={`${section.heading}-${index}`} style={{ gap: 2 }}>
                {section.heading ? (
                  <Text
                    {...typeCap("bodySmall")}
                    style={{
                      color: t.fg,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.semibold,
                    }}
                  >
                    {section.heading}
                  </Text>
                ) : null}
                {section.body ? (
                  <Text
                    {...typeCap("bodySmall")}
                    style={{
                      color: t.fgMuted,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {section.body}
                  </Text>
                ) : null}
              </View>
            ))}
          {diagnose.data.fixes.slice(0, 4).map((fix) => (
            <Text
              key={fix.action}
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {`${forwardArrow()} ${fix.action}${fix.impact ? ` (${fix.impact})` : ""}`}
            </Text>
          ))}
        </View>
      ) : null}
    </OpsCard>
  );
}
