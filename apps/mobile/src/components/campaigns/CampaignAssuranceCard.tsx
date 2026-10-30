import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { Pill } from "@/components/Pill";
import { SkeletonCard } from "@/components/Skeleton";
import { TextLink } from "@/components/TextLink";
import { useToast } from "@/components/Toast";
import {
  AdvisoryLine,
  AssuranceActionLink,
  AssuranceShell,
  BodyText,
  CardHeader,
  FullReceiptLink,
  SourceRow,
} from "@/components/campaigns/CampaignAssurancePrimitives";
import { CampaignAssuranceBlockers } from "@/components/campaigns/CampaignAssuranceBlockers";
import { CampaignAssuranceProvenance } from "@/components/campaigns/CampaignAssuranceProvenance";
import {
  type MobileCampaignAssuranceReceipt,
  useCampaignAssurance,
} from "@/hooks/useCampaignAssurance";
import { useAssuranceRunControls } from "@/hooks/useCampaignAssuranceActions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  campaignAssuranceWebUrl,
  MOBILE_ASSURANCE_SOURCE_LABELS,
  MOBILE_ASSURANCE_SOURCE_ORDER,
  mobileAssuranceNoReceiptCopy,
  mobileAssuranceUnavailableMeaning,
  mobileAssuranceVerdict,
} from "@/lib/campaignAssurance";
import { assuranceAdvisorySummary } from "@/lib/campaignAssuranceGate";
import { PUBLIC_APP_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The phone-sized view of the immutable Campaign Assurance receipt, plus the two
 * verbs a phone may perform against it.
 *
 * This card used to be read-only and said so, on a premise that was half stale.
 * "Remediation must produce a new frozen revision" is true and still is —
 * clearing a blocking finding is a content change and stays where the campaign is
 * edited. But it was generalised into refusing everything, including the one verb
 * that unblocks the commonest refusals: POST /assurance-runs takes an OPTIONAL
 * revision and send plan, and derives both server-side through
 * Preparer.PrepareAssuranceSnapshot (campaignassuranceapi/handlers.go:242-263,
 * wired at campaign_assurance_composition.go:159). Two of the five send refusals —
 * `_required` and `_stale` — are answered exactly by re-running, so the operator
 * who is refused at 11pm can now fix it here instead of being told to find a desk.
 *
 * It still never implies a client-side status can bypass the server's send-time
 * gate, and it never offers a control the server would refuse: Cancel appears only
 * for a run in `queued`/`running`, and both verbs are hidden below `editor`.
 */
export function CampaignAssuranceCard({ campaignId }: { campaignId: string }) {
  const { t } = useTheme();
  const { toast } = useToast();
  const gate = useOnlineQueryGate();
  const query = useCampaignAssurance(campaignId);
  const [expanded, setExpanded] = useState(false);
  const webUrl = campaignAssuranceWebUrl(PUBLIC_APP_BASE_URL, campaignId);

  const openFullReceipt = useCallback(() => {
    if (!webUrl) return;
    haptics.tap();
    void WebBrowser.openBrowserAsync(webUrl).catch(() =>
      toast({ kind: "error", message: "Couldn't open the full receipt." }),
    );
  }, [toast, webUrl]);

  const latestEnvelope = query.data?.latest;
  const receipt = latestEnvelope?.data;
  const evidence = receiptEvidence(query.data);
  const disclosures = latestEnvelope?.measurement.source_classes ?? [];
  const sourceDisclosures = MOBILE_ASSURANCE_SOURCE_ORDER.map(
    (sourceClass) =>
      disclosures.find((source) => source.class === sourceClass) ?? {
        class: sourceClass,
        present: false,
        meaning:
          "This receipt did not disclose evidence for this source class.",
      },
  );
  const missingSources = sourceDisclosures.filter((source) => !source.present);
  const unavailableExtractions =
    evidence?.extractions.items.filter((item) => item.status !== "complete") ??
    [];
  const blockers =
    evidence?.findings.items
      .filter((finding) => finding.blocking)
      .slice(0, 3) ?? [];
  // The evidence read already pays for up to 200 findings; the non-blocking ones
  // (every F06-F11 check) were fetched and then dropped on the floor.
  const advisories = assuranceAdvisorySummary(evidence?.findings.items);
  const actions = useAssuranceRunControls({
    campaignId,
    effectiveRole: gate.effectiveRole,
    runId: receipt?.detail.run.id,
    runState: receipt?.detail.run.state,
    hasReceipt: Boolean(receipt),
    toast,
  });

  if (query.isLoading && gate.enabled) {
    return <SkeletonCard lines={4} style={{ marginTop: 12 }} />;
  }

  if (!gate.enabled && !query.data) {
    return (
      <AssuranceShell>
        <CardHeader tone="neutral" status="Offline" />
        <BodyText color={t.fgMuted}>
          This receipt has not been cached on this device. Reconnect to load the
          exact Campaign Assurance state.
        </BodyText>
      </AssuranceShell>
    );
  }

  if (query.isError) {
    return (
      <AssuranceShell>
        <CardHeader tone="warning" status="Unavailable" />
        <BodyText color={t.fgMuted}>
          The receipt could not be loaded. This is not a passing result.
        </BodyText>
        <TextLink
          onPress={() => void query.refetch()}
          textStyle={{ color: t.accent, fontFamily: FONT.semibold }}
        >
          Try again
        </TextLink>
      </AssuranceShell>
    );
  }

  if (!receipt) {
    return (
      <AssuranceShell>
        <CardHeader tone="neutral" status="No receipt" />
        <BodyText color={t.fgMuted}>
          {mobileAssuranceNoReceiptCopy(actions.control === "start")}
        </BodyText>
        {actions.control === "start" ? (
          <AssuranceActionLink
            onPress={actions.press}
            pending={actions.pending}
            accessibilityLabel="Run Campaign Assurance for this campaign"
            label="Run Campaign Assurance"
            pendingLabel="Starting…"
          />
        ) : null}
        <FullReceiptLink url={webUrl} onPress={openFullReceipt} />
      </AssuranceShell>
    );
  }

  const run = receipt.detail.run;
  const verdict = mobileAssuranceVerdict(receipt);
  const score = run.overall_score;

  return (
    <AssuranceShell>
      <CardHeader tone={verdict.tone} status={verdict.label} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pill
          label={`${run.blocking_finding_count} blocker${run.blocking_finding_count === 1 ? "" : "s"}`}
          tone={run.blocking_finding_count > 0 ? "danger" : "success"}
          accessibilityLabel={`${run.blocking_finding_count} blocking findings`}
        />
        <Pill
          label={
            score == null
              ? "Predicted score unavailable"
              : `Predicted score ${score}`
          }
          tone={score == null ? "warning" : "info"}
        />
        <Pill label={`Run ${run.run_no}`} tone="neutral" />
      </View>

      <BodyText color={t.fgMuted}>{verdict.detail}</BodyText>

      <CampaignAssuranceBlockers
        campaignId={campaignId}
        runId={run.id}
        blockers={blockers}
        blockingFindingCount={run.blocking_finding_count}
        overrides={evidence?.overrides.items}
        effectiveRole={gate.effectiveRole}
        online={gate.enabled}
        toast={toast}
      />

      <AdvisoryLine summary={advisories} />

      <View style={{ gap: 7 }}>
        {sourceDisclosures.map((source) => (
          <SourceRow
            key={source.class}
            label={MOBILE_ASSURANCE_SOURCE_LABELS[source.class]}
            present={source.present}
            meaning={source.meaning}
          />
        ))}
        <SourceRow
          label={MOBILE_ASSURANCE_SOURCE_LABELS.unavailable}
          present={
            missingSources.length > 0 ||
            unavailableExtractions.length > 0 ||
            evidence === null
          }
          meaning={mobileAssuranceUnavailableMeaning(
            missingSources,
            unavailableExtractions.length,
            evidence === null,
          )}
          unavailableBucket
        />
      </View>

      <BodyText color={t.fgSubtle}>
        Modeled output is a prediction, not an observation of a provider&apos;s
        private inbox. Controlled observations are identified separately by the
        receipt disclosure above.
      </BodyText>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          expanded ? "Hide receipt provenance" : "Show receipt provenance"
        }
        accessibilityState={{ expanded }}
        onPress={() => {
          haptics.tap();
          setExpanded((current) => !current);
        }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {expanded ? "Hide provenance" : "Show provenance"}
        </Text>
      </Pressable>

      {expanded ? (
        <CampaignAssuranceProvenance receipt={receipt} evidence={evidence} />
      ) : null}

      <View
        style={{
          borderTopColor: t.borderSubtle,
          borderTopWidth: 1,
          paddingTop: 12,
          gap: 6,
        }}
      >
        <BodyText color={t.fgMuted}>
          Content remediation still happens where you edit the campaign. When
          policy permits, an owner or admin can record a reasoned immutable
          decision here; the server still revalidates exact identities at send
          time. Re-running is also available here.
        </BodyText>
        {actions.control === "cancel" ? (
          <AssuranceActionLink
            onPress={actions.press}
            pending={actions.pending}
            accessibilityLabel="Cancel this Campaign Assurance run"
            label="Cancel this run"
            pendingLabel="Cancelling…"
          />
        ) : null}
        {actions.control === "rerun" ? (
          <AssuranceActionLink
            onPress={actions.press}
            pending={actions.pending}
            accessibilityLabel="Run Campaign Assurance again for the current content"
            label="Run again for current content"
            pendingLabel="Starting…"
          />
        ) : null}
        <FullReceiptLink url={webUrl} onPress={openFullReceipt} />
      </View>
    </AssuranceShell>
  );
}

function receiptEvidence(
  data: MobileCampaignAssuranceReceipt | null | undefined,
) {
  return data?.evidence?.data ?? null;
}
