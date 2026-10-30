/**
 * CampaignSendModal — the last screen between a thumb and a send to a
 * whole list.
 *
 * It used to be a paragraph of copy plus the Inbox-Reality placement
 * predictor. It never showed:
 *   - the six pre-send gates the backend already computes (checklist.go);
 *   - the audience — no recipient count, no suppression exclusions, no
 *     over-cap warning. The count appeared only AFTER the send, in an alert.
 *
 * Both are now read before the confirm, and both are read-scoped server-side
 * so a viewer can inspect what a send would do without being able to do it.
 *
 * Escalation ladder:
 *   ready + within cap  → Send now
 *   over cap OR failing gates → typed confirmation (ConfirmSheet) naming the
 *   consequence, mirroring desktop's checklistFailureOverride / cap block.
 *
 * The voice-fidelity check joins that ladder on the same terms as the link
 * check: opt-in (one round trip to services/voice, not something to fire on
 * every open), and escalating only when it comes back CRITICAL — a stylistic
 * wobble is information the operator is already looking at, and turning every
 * one into a typed phrase trains people to type through the one that mattered.
 * Only editors and above see it: POST /api/v1/voice/drift is write:campaigns
 * at the mount site (main.go:4146) AND session-role `editor` in
 * routeauth/manifest.json, so a viewer would get a button that can only 403.
 *
 * The unified pre-send verdict (POST /api/v1/presend/verdict — EQ score +
 * voice drift + inbox placement, composed server-side) joins the ladder on
 * the same terms (PresendVerdictSection → PresendVerdictCard): opt-in, editor
 * floor at both the mount site (presend/verdict.go:116) and the manifest,
 * escalating only on CRITICAL.
 * Everything else it can say — warn, incomplete (a leg unreachable; locally
 * the voice sidecar is often absent), a 502 upstream_unavailable, a 404 —
 * is a sentence beside the button, never a block.
 */
import { useCallback, useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { EVENTS } from "@postwave/telemetry";

import { getClient } from "@/api/sdkClient";
import { getClient as getApiClient } from "@/api/client";
import { InboxRealityBanner } from "@/components/InboxRealityBanner";
import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { CampaignAudienceCard } from "@/components/campaigns/CampaignAudienceCard";
import { CampaignAssuranceSendStatus } from "@/components/campaigns/CampaignAssuranceSendStatus";
import { CampaignChecklistCard } from "@/components/campaigns/CampaignChecklistCard";
import { CampaignLinkCheckCard } from "@/components/campaigns/CampaignLinkCheckCard";
import { CampaignPresendChecks } from "@/components/campaigns/CampaignPresendChecks";
import { ModalHeader } from "@/components/campaigns/CampaignDetailControls";
import { PresendOverrideNotice } from "@/components/presend/PresendOverrideNotice";
import { PresendVerdictSection } from "@/components/presend/PresendVerdictSection";
import {
  useCampaignChecklist,
  useCampaignSendPreview,
} from "@/hooks/useCampaignSendChecks";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  linkCheckConsequence,
  readLinkCheck,
  type LinkCheckReading,
} from "@/lib/campaignLinkCheck";
import { summarizeSendPreview } from "@/lib/campaignSendPreview";
import type { PresendVerdictReading } from "@/lib/campaignVerdict";
import {
  presendVerdictBlocks,
  presendVerdictConsequence,
} from "@/lib/presendVerdictGate";
import {
  voiceDriftBlocks,
  voiceDriftConsequence,
  type VoiceDriftReading,
} from "@/lib/voiceDrift";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { track } from "@/lib/telemetry";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

export function CampaignSendModal({
  visible,
  onClose,
  campaignId,
  campaignName,
  subject,
  bodyHtml,
  fromLine,
  onImproveSubject,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  campaignId: string;
  campaignName?: string | undefined;
  subject: string;
  bodyHtml: string;
  /** What the From header will read — input to the AI verdict's checks. */
  fromLine?: string | undefined;
  onImproveSubject?: () => void;
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const [overriding, setOverriding] = useState(false);
  const [drift, setDrift] = useState<VoiceDriftReading | null>(null);
  const [verdict, setVerdict] = useState<PresendVerdictReading | null>(null);
  // Editor floor, enforced twice server-side (see the header). Offline the
  // check cannot run at all, so the card is not offered rather than offered
  // and failing. The same floor gates the verdict card.
  const canCheckVoice =
    gate.enabled && canAccessMinimumRole("editor", gate.effectiveRole, mode);
  // The a11y check's route floor is ADMIN in the routeauth manifest; the
  // verdict and the refine writes are editor. Each affordance is omitted —
  // never disabled — below its floor (CampaignPresendChecks).
  const canCheckA11y =
    gate.enabled && canAccessMinimumRole("admin", gate.effectiveRole, mode);

  // Both reads are scoped to the open sheet: the detail screen shouldn't pay
  // for a suppression resolve on every visit.
  const checklist = useCampaignChecklist(campaignId, { enabled: visible });
  const sendPreview = useCampaignSendPreview(campaignId, { enabled: visible });

  // On-demand: the check makes one real HTTP request per link, so it fires
  // only when the operator asks. A broken link is the one pre-send mistake
  // with no recovery once delivery starts.
  const linkCheck = useMutation({
    mutationFn: async (): Promise<LinkCheckReading> => {
      const { client } = getApiClient();
      const res = await client.request<unknown>(
        "POST",
        `/api/v1/campaigns/${encodeURIComponent(campaignId)}/check-links`,
      );
      return readLinkCheck(res);
    },
    onError: () => haptics.error(),
  });
  const links = linkCheck.data ?? null;

  const summary = checklist.data ?? null;
  const preview = sendPreview.data ?? null;
  const audience = summarizeSendPreview(preview);
  // A missing/unavailable checklist must not block a legitimate send — only a
  // checklist that actually ran and actually failed does.
  const blockedByChecks = summary != null && !summary.ready;
  const brokenLinks = links != null && links.brokenCount > 0;
  // Only a CRITICAL drift verdict escalates. An unrun check never blocks —
  // the affordance is opt-in, and an operator who declined it has not failed
  // anything.
  const offVoice = voiceDriftBlocks(drift);
  // Likewise the verdict: CRITICAL escalates; warn / incomplete / a failed
  // request never do (lib/presendVerdictGate).
  const verdictCritical = presendVerdictBlocks(verdict);
  const needsOverride =
    blockedByChecks ||
    audience.overCap ||
    brokenLinks ||
    offVoice ||
    verdictCritical;

  const sendMutation = useMutation({
    mutationFn: async () => {
      const { client } = getClient();
      return client.campaigns.queue(campaignId);
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["campaign"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-report"] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
      onClose();

      const queued =
        typeof res.recipients_queued === "number" ? res.recipients_queued : 0;

      if (res.status === "approval_required") {
        // The operator was previously told a process started and given no way
        // to observe or advance it — while mobile ships a fully-built
        // Approvals screen that even resolves campaign names for its rows.
        toast({
          kind: "warning",
          message:
            res.message ||
            "Queued for approval — it won't send until it's approved.",
          action: {
            label: "View",
            onPress: () => router.push("/(tabs)/approvals"),
          },
        });
        return;
      }

      track(EVENTS.CAMPAIGN_SENT, {
        source: "mobile_detail",
        recipients_queued: queued,
        overridden: needsOverride,
      });
      toast({
        kind: "success",
        message:
          queued > 0
            ? `Queued to ${plural(queued, "recipient")}.`
            : res.message || "The campaign has been queued.",
      });
    },
    onError: (err: unknown) => {
      toast({
        kind: "error",
        message: campaignErrorMessage(err, "Couldn't queue the campaign."),
      });
    },
  });

  const handleContinue = useCallback(() => {
    if (sendMutation.isPending || overriding) return;
    if (!needsOverride) {
      haptics.impact();
      sendMutation.mutate();
      return;
    }
    // Irreversible + already flagged: escalate to a typed confirmation naming
    // the exact consequence, rather than letting a second tap send anyway.
    setOverriding(true);
    void (async () => {
      try {
        const consequence = [
          blockedByChecks && summary
            ? `Failing checks: ${summary.blockingLabels.join(", ")}.`
            : null,
          linkCheckConsequence(links),
          voiceDriftConsequence(drift),
          presendVerdictConsequence(verdict),
          audience.capWarning,
        ]
          .filter(Boolean)
          .join(" ");
        const ok = await confirm({
          title:
            blockedByChecks || brokenLinks || offVoice || verdictCritical
              ? "Send anyway?"
              : "Send over today's cap?",
          message: `${audience.sentence}. This can't be undone once delivery starts.`,
          confirmLabel: "Send anyway",
          destructive: true,
          ...(consequence ? { consequence } : {}),
          ...(campaignName ? { confirmPhrase: campaignName } : {}),
        });
        if (ok) {
          haptics.impact();
          sendMutation.mutate();
        }
      } finally {
        setOverriding(false);
      }
    })();
  }, [
    audience.capWarning,
    audience.sentence,
    blockedByChecks,
    brokenLinks,
    campaignName,
    confirm,
    drift,
    links,
    needsOverride,
    offVoice,
    overriding,
    sendMutation,
    summary,
    verdict,
    verdictCritical,
  ]);

  const busy = sendMutation.isPending || overriding;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader title="Confirm send" onClose={onClose} />

      <CampaignAudienceCard
        preview={preview}
        loading={sendPreview.isLoading}
        error={sendPreview.error}
        compact
      />

      <CampaignChecklistCard
        summary={summary}
        loading={checklist.isLoading}
        error={checklist.error}
      />

      <CampaignAssuranceSendStatus campaignId={campaignId} visible={visible} />

      <CampaignLinkCheckCard
        reading={links}
        running={linkCheck.isPending}
        error={linkCheck.error}
        onRun={() => linkCheck.mutate()}
        disabled={busy}
      />

      <CampaignPresendChecks
        campaignId={campaignId}
        subject={subject}
        bodyHtml={bodyHtml}
        fromLine={fromLine ?? ""}
        canEdit={canCheckVoice}
        canAdmin={canCheckA11y}
        visible={visible}
        disabled={busy}
      />

      <PresendVerdictSection
        offered={canCheckVoice}
        subject={subject}
        bodyHtml={bodyHtml}
        fromLine={fromLine}
        onVerdict={setVerdict}
        onDrift={setDrift}
        disabled={busy}
      />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontSize: 13,
          marginBottom: 12,
          fontFamily: FONT.regular,
        }}
      >
        Inbox Reality predicts placement before you send. Review and confirm —
        sending will proceed even if the predictor is unavailable.
      </Text>

      <InboxRealityBanner
        subject={subject}
        bodyHtml={bodyHtml}
        busy={busy}
        continueLabel={needsOverride ? "Send anyway…" : "Send now"}
        onCancel={onClose}
        onContinue={handleContinue}
        {...(onImproveSubject ? { onImproveSubject } : {})}
      />

      {needsOverride ? (
        <PresendOverrideNotice
          blockedByChecks={blockedByChecks}
          brokenLinks={brokenLinks}
          offVoice={offVoice}
          verdictCritical={verdictCritical}
        />
      ) : null}
    </KeyboardFormSheet>
  );
}
