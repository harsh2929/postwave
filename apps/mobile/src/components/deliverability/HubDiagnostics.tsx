/**
 * HubDiagnostics — the "so what do I look at next" block below the hub's
 * alarms.
 *
 * The hub answers "is sending healthy". These five cards answer the follow-up
 * questions, in the order an operator actually asks them: which provider, why
 * they bounced, is a domain still ramping, is a policy holding sends, and the
 * third channel's suppression state.
 *
 * It owns its own queries rather than taking them as props so the hub screen
 * stays a list of sections and does not grow five more hooks. Each read is a
 * SIDE signal: a failed one renders its own honest reason and never an implied
 * "nothing here" — desktop's D10 lesson, which this cluster keeps paying for.
 */
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { BounceClassCard } from "@/components/deliverability/BounceClassCard";
import { IspBreakdownCard } from "@/components/deliverability/IspBreakdownCard";
import { PushSuppressionCard } from "@/components/deliverability/PushSuppressionCard";
import { SendWindowCard } from "@/components/deliverability/SendWindowCard";
import { WarmupCard } from "@/components/deliverability/WarmupCard";
import { useToast } from "@/components/Toast";
import { WarmupOpsControls } from "@/components/deliverability/WarmupOpsControls";
import {
  useBounceClasses,
  useIspBreakdown,
  useSendWindow,
  useSetSendWindowTier,
  useSetWarmupStatus,
  useWarmupPlans,
  useWarmupToday,
} from "@/hooks/useDeliverabilityDiagnostics";
import {
  usePushSuppressionAccess,
  usePushSuppressions,
} from "@/hooks/usePushSuppressions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
// Warm-up and the send-window WRITE are `ScopeAdmin` server-side, so the
// affordance is gated on the session role — a viewer must never be shown a
// control whose only possible outcome is a 403. The predicate is the app's
// EXISTING one rather than a second local copy: `campaignAccess` names four
// admin spellings the API emits (admin / owner / superadmin / super_admin),
// and a re-implementation here would silently lock a superadmin out.
import { isAdminRole } from "@/lib/campaignAccess";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import type { SendWindowTier } from "@/lib/deliverabilityControls";
import {
  diagnosticNotice,
  warmupPauseConsequence,
} from "@/lib/deliverabilityDiagnostics";
import { errorPresentation } from "@/lib/errorCopy";
import { haptics } from "@/lib/haptics";
import { mergePushSuppressionPages } from "@/lib/pushSuppressions";

export function HubDiagnostics() {
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const admin = isAdminRole(gate.effectiveRole);
  const offline = !gate.enabled;

  const isp = useIspBreakdown(30);
  const bounces = useBounceClasses("30d");
  const pushAccess = usePushSuppressionAccess();
  const push = usePushSuppressions("all", pushAccess);
  const sendWindow = useSendWindow();
  // The plan list is admin-only; asking as a viewer buys a guaranteed 403.
  const warmupPlans = useWarmupPlans(admin);
  const setWarmupStatus = useSetWarmupStatus();
  const onSetWarmupStatus = useCallback(
    async (plan: { domain: string; targetDaily: number }, status: string) => {
      haptics.tap();
      try {
        await setWarmupStatus.mutateAsync({ domain: plan.domain, status });
        toast({
          kind: "success",
          message:
            status === "paused"
              ? warmupPauseConsequence(plan)
              : `${plan.domain} is ramping again.`,
        });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(err).message ||
            `Couldn't update the warm-up for ${plan.domain}.`,
        });
      }
    },
    [setWarmupStatus, toast],
  );

  const plans = Array.isArray(warmupPlans.data) ? warmupPlans.data : [];
  const [pickedDomain, setPickedDomain] = useState<string>("");
  // Follow the data when the operator has not chosen: a stale pick that has
  // dropped out of the plan list would otherwise fetch a 404 forever.
  const selectedDomain =
    pickedDomain && plans.some((p) => p.domain === pickedDomain)
      ? pickedDomain
      : (plans[0]?.domain ?? "");
  const today = useWarmupToday(selectedDomain);

  const setTier = useSetSendWindowTier();
  const policy = sendWindow.data;
  const pushRegistry = useMemo(() => {
    if (!push.isSuccess) return null;
    try {
      return mergePushSuppressionPages(push.data.pages);
    } catch {
      return null;
    }
  }, [push.data?.pages, push.isSuccess]);
  const pushContractFailed = push.isSuccess && pushRegistry === null;

  function changeTier(tier: SendWindowTier) {
    if (!policy) return;
    setTier.mutate(
      { policy, tier },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message:
              tier === "off"
                ? "Send-window enforcement is off."
                : `Send window now ${tier === "block" ? "blocks" : "warns"}.`,
          }),
        onError: (error) =>
          toast({
            kind: "error",
            message: writeFailureMessage(
              error,
              "Couldn't change the enforcement tier.",
            ),
          }),
      },
    );
  }

  return (
    <View style={{ marginTop: 4 }}>
      <IspBreakdownCard
        breakdown={isp.data}
        unavailableReason={diagnosticNotice(
          "The provider breakdown",
          isp.isError || offline,
          offline,
        )}
      />
      <BounceClassCard
        breakdown={bounces.data}
        unavailableReason={diagnosticNotice(
          "The bounce breakdown",
          bounces.isError || offline,
          offline,
        )}
      />
      <WarmupCard
        plans={plans}
        today={today.data}
        selectedDomain={selectedDomain}
        onSelectDomain={setPickedDomain}
        unavailableReason={
          !admin
            ? null
            : diagnosticNotice(
                "Warm-up status",
                warmupPlans.isError || offline,
                offline,
              )
        }
        // Null below admin (PATCH .../status is ScopeAdmin) and null offline,
        // because a queued pause reports a ramp as held while it keeps
        // climbing on schedule.
        onSetStatus={
          admin && !offline
            ? (plan, status) => void onSetWarmupStatus(plan, status)
            : null
        }
        settingStatus={setWarmupStatus.isPending}
      />
      {/* The bookends WarmupCard never had: start a ramp, remove a ramp.
          Both verbs are ScopeAdmin and online-only, so the controls mount
          only for an online admin — a viewer sees the ramp, no levers. */}
      {admin && !offline ? (
        <WarmupOpsControls
          selectedDomain={selectedDomain}
          hasPlanForSelected={plans.some((plan) => plan.domain === selectedDomain)}
        />
      ) : null}
      <SendWindowCard
        policy={sendWindow.isError ? null : policy}
        unavailableReason={diagnosticNotice(
          "The send-window policy",
          sendWindow.isError || offline,
          offline,
        )}
        canEdit={admin && !offline}
        saving={setTier.isPending}
        onChangeTier={changeTier}
      />
      <PushSuppressionCard
        rows={pushRegistry?.items}
        total={pushRegistry?.total ?? null}
        hasMore={pushRegistry?.hasMore ?? false}
        loading={push.isPending && push.access.roleAllowed}
        restrictedReason={!push.access.roleAllowed ? push.access.denialReason : null}
        unavailableReason={
          pushContractFailed
            ? "The customer push registry response could not be verified, so no count is shown."
            : diagnosticNotice(
                "The customer push registry",
                push.isError || offline,
                offline,
              )
        }
      />
    </View>
  );
}
