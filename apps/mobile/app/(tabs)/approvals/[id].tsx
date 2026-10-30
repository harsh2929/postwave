/**
 * Approval detail — read the request, then decide.
 *
 * Reached by tapping a queue row and by an `approval.requested` push
 * (deepLinks routes the notification's entity_id straight here, rather
 * than dropping the approver on a list they then have to search).
 *
 * The screen re-fetches GET /api/v1/approvals/{id} on open with
 * staleTime: 0, because the list behind it is a poll up to 60s old and the
 * whole point of a detail view before an irreversible decision is that the
 * state you are looking at is current.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { EVENTS } from "@postwave/telemetry";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { ErrorState } from "@/components/ErrorState";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonDetail } from "@/components/Skeleton";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { ApprovalChainProgress } from "@/components/approvals/ApprovalChainProgress";
import { ApprovalDetailBody } from "@/components/approvals/ApprovalDetailBody";
import { ApprovalFreshnessLine } from "@/components/approvals/ApprovalFreshnessLine";
import { RejectReasonModal } from "@/components/approvals/RejectReasonModal";
import {
  approvalActionGate,
  approvalGateNotice,
  isApprovalExpired,
  rejectDraftSubmitState,
  resourceLabel,
  type RejectDraft,
} from "@/components/approvals/approvalPresentation";
import {
  approvalDecisionSuccessMessage,
  decisionErrorMessage,
  useApproval,
  useApprovalAgentRun,
  useApprovalDecision,
  useApprovalResourceContext,
  type ApprovalDecision,
} from "@/hooks/useApprovals";
import { useApprovalChain } from "@/hooks/useApprovalChain";
import { useEntityActivity } from "@/hooks/useEntityActivity";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { freshnessSentence } from "@/lib/auditGrouping";
import { FONT } from "@/lib/fonts";
import { goBackOr } from "@/lib/nav";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useTickingNow } from "@/hooks/useTickingNow";
import { useRecordLastViewed } from "@/hooks/useActivityCursor";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { track } from "@/lib/telemetry";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

export default function ApprovalDetail() {
  const { t } = useTheme();
  useScreenViewed("approval-detail");
  const { toast } = useToast();
  const confirm = useConfirm();
  const params = useLocalSearchParams<{
    id?: string | string[];
    reject?: string | string[];
  }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  // Cross-device continuity: tell the server this is where the user is,
  // so their other devices can offer "Continue". Best-effort and silent.
  useRecordLastViewed("approval", id);
  // GOVERNANCE#37 — set by a Reject action on an approval push that reached us
  // without a usable reason (lib/pushDecisionFlow `pushRejectRouteParams`).
  // The notification button cannot bypass the mandatory reason, so it hands the
  // approver to this screen with the sheet that enforces it already open.
  const rejectRequested =
    (Array.isArray(params.reject) ? params.reject[0] : params.reject) === "1";
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canDecide = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const now = useTickingNow(canDecide);

  const detail = useApproval(canDecide ? id : null);
  const approval = detail.data ?? null;
  const context = useApprovalResourceContext(approval);
  // Offer this pending decision to Handoff — and ONLY to Handoff. The policy
  // table already said so (ENTITY_ACTIVITY_DISCLOSURE in lib/entityActivity.ts:
  // `approval: { handoff: true, spotlight: false }`, "a pending decision, and
  // one the viewer may lose the right to see"), but this was the one declared
  // handoff entity with no screen donating one, so the rule described nothing.
  // Continuing on the user's own Mac is exactly the shape of this task: the
  // request arrives on the phone, the thing being approved is usually easier to
  // read on a desktop.
  //
  // The empty id when `!canDecide` is the gate, since the hook cannot be called
  // conditionally: `entityActivityDescriptor` returns null for an empty id, so
  // a viewer who is not allowed to load this request donates nothing about it.
  // The app lock is honoured by the hook itself, fail-closed until it resolves.
  useEntityActivity({
    entity: "approval",
    id: canDecide ? (id ?? "") : "",
    // Never the raw id — see the same note in lib/entityActivity.ts. Falls back
    // to the resource kind ("Campaign send") while the detail is still loading,
    // and to "Approval" if even that is unknown.
    title:
      context.title ??
      (approval ? resourceLabel(approval.resourceType) : null),
  });
  const agentRun = useApprovalAgentRun(approval);
  const chain = useApprovalChain(
    canDecide ? id : null,
    approval?.resourceType ?? null,
  );
  const refresh = useManualRefresh([detail.refetch], { enabled: gate.enabled });
  // The control the reject sheet came from, so screen-reader focus can be
  // handed back to it on dismiss (see RejectReasonModal.restoreFocusTo).
  const rejectRef = useRef<View | null>(null);
  // "Is what I am about to decide on current?" — a compliance surface owes
  // the reader that, and `now` already ticks so the answer ages honestly.
  const freshness = freshnessSentence("This request", detail.dataUpdatedAt, now);

  const [rejectDraft, setRejectDraft] = useState<RejectDraft>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const {
    mutateAsync: decideAsync,
    isPending: isDeciding,
  } = useApprovalDecision();

  const gateNotice = approvalGateNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
  });

  const runDecision = useCallback(
    (decision: ApprovalDecision, notes?: string) => {
      if (!approval || isDeciding) return;
      const verb = decision === "approve" ? "Approve" : "Reject";
      const input: { id: string; decision: ApprovalDecision; notes?: string } =
        notes && notes.trim()
          ? { id: approval.id, decision, notes: notes.trim() }
          : { id: approval.id, decision };
      haptics.impact();
      const requestedAt = Date.parse(approval.requestedAt);
      decideAsync(input)
        .then((response) => {
          const result = approvalDecisionSuccessMessage(decision, response);
          if (result.followupFailed) {
            haptics.error();
            toast({ kind: "warning", message: result.message });
          } else {
            haptics.success();
            toast({ kind: "success", message: result.message });
          }
          track(EVENTS.APPROVAL_DECIDED, {
            decision,
            surface: "detail",
            followup_failed: result.followupFailed,
            ...(Number.isFinite(requestedAt)
              ? {
                  seconds_since_requested: Math.max(
                    0,
                    Math.round((Date.now() - requestedAt) / 1000),
                  ),
                }
              : {}),
          });
          // The queue is the natural place to land after clearing one.
          if (router.canGoBack()) router.back();
        })
        .catch((e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `${verb} failed. ${decisionErrorMessage(e)}`,
          });
        });
    },
    [approval, decideAsync, isDeciding, toast],
  );

  const onApprove = useCallback(async () => {
    if (!approval) return;
    const label = context.title ?? resourceLabel(approval.resourceType);
    const ok = await confirm({
      title: `Approve "${label}"?`,
      message:
        "This decision is final, cannot be undone, and is recorded in the audit log.",
      confirmLabel: "Approve",
      consequence: "The requested action will proceed immediately.",
    });
    if (ok) runDecision("approve");
  }, [approval, confirm, context.title, runDecision]);

  // Open the reject sheet for an approver sent here BY a Reject notification
  // action that carried no reason (GOVERNANCE#37). Waits for the fetch, because
  // the sheet's label comes from the loaded request, and fires at most once per
  // mount so dismissing it does not immediately re-open it.
  const autoRejectOpened = useRef(false);
  useEffect(() => {
    if (!rejectRequested || autoRejectOpened.current) return;
    if (!canDecide || !approval || approval.status !== "pending") return;
    autoRejectOpened.current = true;
    setRejectError(null);
    setRejectDraft({
      id: approval.id,
      label: context.title ?? resourceLabel(approval.resourceType),
      reason: "",
    });
  }, [approval, canDecide, context.title, rejectRequested]);

  const submitReject = useCallback(() => {
    const submit = rejectDraftSubmitState(rejectDraft, isDeciding);
    if (submit.kind === "idle" || submit.kind === "busy") return;
    if (submit.kind === "reason_required") {
      setRejectError(submit.message);
      haptics.warning();
      return;
    }
    setRejectDraft(null);
    setRejectError(null);
    runDecision("reject", submit.input.notes);
  }, [isDeciding, rejectDraft, runDecision]);

  if (!canDecide) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Approval" onBack={() => goBackOr("/(tabs)/approvals")} />
        <View style={{ padding: 16 }}>
          <MobileScopeNotice
            title="Approvals need an admin role"
            body="Deciding approval requests is limited to workspace owners and admins."
          />
        </View>
      </SafeAreaView>
    );
  }

  const actionGate = approvalActionGate({
    pending: approval?.status === "pending",
    expired: approval ? isApprovalExpired(approval.expiresAt, now) : false,
    ownRequest: Boolean(
      approval?.requestedByUserId &&
        gate.userId &&
        approval.requestedByUserId === gate.userId,
    ),
    gated: Boolean(gateNotice),
    busy: isDeciding,
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Approval" onBack={() => goBackOr("/(tabs)/approvals")} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 14 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {detail.isLoading && !approval ? <SkeletonDetail sections={3} /> : null}
        {detail.isError && !approval ? (
          <ErrorState
            error={detail.error}
            onRetry={() => void detail.refetch()}
          />
        ) : null}
        {approval ? (
          <ApprovalDetailBody
            approval={approval}
            context={context}
            agentRun={agentRun.data ?? null}
            agentRunLoading={agentRun.isLoading}
            currentUserId={gate.userId}
            now={now}
          />
        ) : null}
        {/* "Am I the blocker, or is someone ahead of me?" — above the decision
            bar, because it changes whether a decision is even the next move. */}
        <ApprovalChainProgress
          view={chain.view}
          loading={chain.loading}
          viewerRole={gate.effectiveRole}
        />
        <ApprovalFreshnessLine sentence={freshness} />
        {approval && approval.status === "pending" ? (
          <DecisionBar
            canAct={actionGate.canAct}
            busy={isDeciding}
            blockedReason={actionGate.blockedReason}
            rejectRef={rejectRef}
            onApprove={() => void onApprove()}
            onReject={() => {
              setRejectError(null);
              setRejectDraft({
                id: approval.id,
                label: context.title ?? resourceLabel(approval.resourceType),
                reason: "",
              });
            }}
          />
        ) : null}
      </ScrollView>
      <RejectReasonModal
        visible={Boolean(rejectDraft)}
        // Cancelling a rejection returns VoiceOver to the Reject button that
        // opened the sheet, instead of dropping focus at the top of a screen
        // the user has already read.
        restoreFocusTo={rejectRef}
        label={rejectDraft?.label ?? ""}
        reason={rejectDraft?.reason ?? ""}
        busy={isDeciding}
        error={rejectError}
        onChangeReason={(reason) => {
          setRejectError(null);
          setRejectDraft((cur) => (cur ? { ...cur, reason } : cur));
        }}
        onCancel={() => {
          setRejectDraft(null);
          setRejectError(null);
        }}
        onSubmit={submitReject}
      />
    </SafeAreaView>
  );
}

function DecisionBar({
  canAct,
  busy,
  blockedReason,
  rejectRef,
  onApprove,
  onReject,
}: {
  canAct: boolean;
  busy: boolean;
  blockedReason: string | null;
  /** Focus target for the reject sheet to hand back to on dismiss. */
  rejectRef: React.RefObject<View | null>;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 10 }}>
      {blockedReason ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {blockedReason}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          ref={rejectRef}
          onPress={onReject}
          disabled={!canAct}
          accessibilityRole="button"
          accessibilityLabel="Reject this request"
          accessibilityState={{ disabled: !canAct }}
          style={{
            flex: 1,
            minHeight: 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.danger,
            opacity: canAct ? 1 : 0.5,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.danger,
              ...typeStyle("body"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            Reject
          </Text>
        </Pressable>
        <Pressable
          onPress={onApprove}
          disabled={!canAct}
          accessibilityRole="button"
          accessibilityLabel="Approve this request"
          accessibilityState={{ disabled: !canAct, busy }}
          style={{
            flex: 1,
            minHeight: 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            backgroundColor: t.accent,
            opacity: canAct ? 1 : 0.5,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.accentFg,
              ...typeStyle("body"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {busy ? "Deciding…" : "Approve"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
