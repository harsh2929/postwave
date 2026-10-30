import { useCallback, useState } from "react";
import type {
  CampaignAssuranceFinding,
  CampaignAssuranceOverride,
} from "@postwave/sdk";
import { Text, View } from "react-native";

import {
  BodyText,
  ReceiptValue,
} from "@/components/campaigns/CampaignAssurancePrimitives";
import {
  CampaignAssuranceFindingGovernance,
  CampaignAssuranceOverrideSheet,
  type MobileAssuranceOverrideDraft,
} from "@/components/campaigns/CampaignAssuranceOverrideControl";
import { useOverrideAssuranceFinding } from "@/hooks/useCampaignAssuranceActions";
import { latestAssuranceOverride } from "@/lib/campaignAssuranceOverride";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type Notice = { kind: "success" | "error"; message: string };

export function CampaignAssuranceBlockers({
  campaignId,
  runId,
  blockers,
  blockingFindingCount,
  overrides,
  effectiveRole,
  online,
  toast,
}: {
  campaignId: string;
  runId: string;
  blockers: CampaignAssuranceFinding[];
  blockingFindingCount: number;
  overrides: readonly CampaignAssuranceOverride[] | undefined;
  effectiveRole: string | null;
  online: boolean;
  toast: (notice: Notice) => void;
}) {
  const { t } = useTheme();
  const [governedFinding, setGovernedFinding] =
    useState<CampaignAssuranceFinding | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const overrideFinding = useOverrideAssuranceFinding(campaignId);
  const submitOverride = useCallback(
    (draft: MobileAssuranceOverrideDraft) => {
      if (!governedFinding) return;
      setOverrideError(null);
      overrideFinding.mutate(
        {
          runId,
          findingId: governedFinding.id,
          decision: draft.decision,
          reason: draft.reason,
        },
        {
          onSuccess: () => {
            toast({
              kind: "success",
              message:
                "Governed decision recorded against the immutable finding.",
            });
            setGovernedFinding(null);
          },
          onError: (error) => {
            const message = campaignErrorMessage(
              error,
              "Couldn't record the governed decision.",
            );
            setOverrideError(message);
            toast({ kind: "error", message });
          },
        },
      );
    },
    [governedFinding, overrideFinding, runId, toast],
  );

  if (blockingFindingCount === 0) return null;
  return (
    <View style={{ gap: 7 }}>
      {blockers.map((finding) => (
        <View
          key={finding.id}
          style={{
            borderColor: t.danger,
            borderWidth: 1,
            borderRadius: 10,
            padding: 10,
            gap: 3,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.danger,
              ...typeStyle("label"),
              fontFamily: FONT.semibold,
            }}
          >
            {finding.code}
          </Text>
          <BodyText color={t.fgMuted}>{finding.explanation}</BodyText>
          <ReceiptValue
            label="Finding receipt"
            value={finding.receipt_hash}
            hash
          />
          <CampaignAssuranceFindingGovernance
            finding={finding}
            existingOverride={latestAssuranceOverride(overrides, finding.id)}
            effectiveRole={effectiveRole}
            online={online}
            onOpen={() => {
              setOverrideError(null);
              setGovernedFinding(finding);
            }}
          />
        </View>
      ))}
      {blockers.length < blockingFindingCount ? (
        <BodyText color={t.fgSubtle}>
          {blockers.length === 0
            ? "Blocking finding details are unavailable on this read."
            : `${blockingFindingCount - blockers.length} more blocker(s) are available in the full receipt.`}
        </BodyText>
      ) : null}
      <CampaignAssuranceOverrideSheet
        finding={governedFinding}
        busy={overrideFinding.isPending}
        submitError={overrideError}
        onClose={() => {
          if (overrideFinding.isPending) return;
          setOverrideError(null);
          setGovernedFinding(null);
        }}
        onSubmit={submitOverride}
      />
    </View>
  );
}
