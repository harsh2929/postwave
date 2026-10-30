/**
 * usePushResponseRouting — what happens when the user acts on a notification.
 * Extracted from the root layout (SHELL#78) and re-presented through the app's
 * own primitives (SHELL#72 / NATIVE#37).
 *
 * Two shapes:
 *
 *  1. An Approve / Reject action button on an "approval" push. The app may be
 *     backgrounded or killed, so the decision is POSTed through the API client
 *     directly and the approvals cache is invalidated so the pending list and
 *     tab badge refresh. We do NOT also navigate — the whole point of an
 *     actionable push is deciding without opening the app.
 *
 *     This used to be a hand-rolled Promise around `Alert.alert`, followed by a
 *     SECOND `Alert` across three outcome branches: up to three OS modals from
 *     one notification tap, unbranded, unhaptic, and heavier than the app's own
 *     confirm sheet. It is now `await confirm(...)` + one toast, which also
 *     restores physical feedback (the sheet thuds on open and on commit; the
 *     outcome toast fires success/error haptics).
 *
 *  2. A default tap or the "View" action routes to the entity via
 *     `routeForNotification`, pushed onto the existing stack so back returns
 *     the user where they were — EXCEPT when the target is the screen already
 *     on top, which replaces instead (SHELL#70). Three notifications about one
 *     campaign are one destination, not three history entries.
 *
 * Each shape arrives by two delivery paths: cold start (app was killed — read
 * once via `lastNotificationResponse` after hydration so routing lands AFTER
 * the auth gate) and foreground/background (the live listener). The cold-start
 * response is consumed exactly once per process: it is the SAME cached object
 * for the process lifetime, so re-processing it would re-POST an
 * already-made decision.
 */
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";

import { revokeSession } from "@/api/authSessions";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useNavigateToHref } from "@/hooks/useNavigateTo";
import { getBiometricLockEnabled, requireDeviceAuth } from "@/lib/biometric";
import { isProbablyOnline } from "@/lib/connectivity";
import { routeForNotification } from "@/lib/deepLinks";
import { haptics } from "@/lib/haptics";
import {
  PUSH_REJECT_ROUTE,
  pushDecisionBlockedNotice,
  pushDecisionConfirmCopy,
  pushDecisionGate,
  pushDecisionOutcomeNotice,
  pushRejectNeedsReasonNotice,
  pushRejectPlan,
  pushRejectRouteParams,
  type PushApprovalDecision,
} from "@/lib/pushDecisionFlow";
import {
  decideApprovalFromNotification,
  lastNotificationResponse,
  parseNotificationAction,
  PUSH_ACTION_APPROVE,
  PUSH_ACTION_REJECT,
} from "@/lib/push";
import { queryClient } from "@/lib/queryClient";
import {
  securitySessionRevokeGate,
  securitySessionRevokeTarget,
} from "@/lib/pushSecuritySession";
import { useAuthStore } from "@/store/auth";

const SECURITY_REVIEW_ROUTE = "/(tabs)/settings";

function decisionFor(
  actionIdentifier: string | undefined,
): PushApprovalDecision | null {
  if (actionIdentifier === PUSH_ACTION_APPROVE) return "approve";
  if (actionIdentifier === PUSH_ACTION_REJECT) return "reject";
  return null;
}

/**
 * The app lock never sees a notification action button.
 *
 * `BiometricGate` protects a React TREE. An action button on a push runs
 * beside that tree, straight into this hook, so on a locked phone "Approve",
 * "Reject" and "Revoke session" were each one tap for whoever was holding the
 * handset — and the confirm sheet we raise renders ABOVE the lock overlay, so
 * the second step was theirs too. Whoever armed the lock asked for exactly
 * this decision to require them.
 *
 * The lock PREFERENCE is the trigger, not the gate's mounted state: the gate
 * has no cross-tree handle, and the preference is the thing the user set. On a
 * phone with no lock nothing changes — demanding Face ID there would tax the
 * one feature actionable pushes exist for. `requireDeviceAuth` additionally
 * fails open on a device with no credential at all, which is the same device
 * the lock itself cannot arm on.
 */
async function deviceOwnerPresent(reason: string): Promise<boolean> {
  if (!(await getBiometricLockEnabled())) return true;
  return requireDeviceAuth(reason);
}

export function usePushResponseRouting(): void {
  const confirm = useConfirm();
  const { toast } = useToast();
  // Three notifications about the SAME campaign used to stack three identical
  // screens (SHELL#70). A repeat of the screen on top now replaces it; a
  // DIFFERENT entity still pushes, because pressing back to reach the previous
  // one is what a user expects.
  const navigate = useNavigateToHref();
  const hydrated = useAuthStore((s) => s.hydrated);
  const canEnterApp = useAuthStore((s) => s.canEnterApp());
  const sessionValidation = useAuthStore((s) => s.sessionValidation);
  const coldNotificationConsumed = useRef(false);

  useEffect(() => {
    if (!hydrated || !canEnterApp) return;
    let cancelled = false;

    /**
     * Returns true when the response was fully handled — a cold-start response
     * may then be marked consumed. Returns false ONLY to ask the caller to
     * retry later: a cached session still re-validating /me is authenticated
     * AND reaching the network, so the decision must be neither dropped nor
     * blamed on being offline.
     */
    async function decide(
      decision: PushApprovalDecision,
      entityId: string,
      retryable: boolean,
      userText: string | undefined,
    ): Promise<boolean> {
      const auth = useAuthStore.getState();
      const gate = pushDecisionGate({
        canUseOnlineServices: auth.canUseOnlineServices(),
        sessionValidation: auth.sessionValidation,
        retryable,
        role: auth.session?.effectiveRole ?? null,
        mode: auth.mode,
      });
      if (gate.kind === "retry_later") return false;
      if (gate.kind !== "confirm") {
        const blocked = pushDecisionBlockedNotice(gate.kind);
        if (blocked) {
          // `warning` toasts are deliberately silent; this one answers a
          // deliberate tap on a notification button, so give it a body.
          if (blocked.kind === "warning") haptics.warning();
          toast({ message: blocked.message, kind: blocked.kind });
        }
        return true;
      }

      // GOVERNANCE#37 — a rejection carries a reason on every other surface,
      // and this button used to be the way around that. The OS collects it via
      // the action's `textInput`; when nothing usable came back we open the
      // request rather than POST a bare reject.
      let notes: string | undefined;
      if (decision === "reject") {
        const plan = pushRejectPlan(userText);
        if (plan.kind === "needs_reason") {
          if (cancelled) return true;
          const notice = pushRejectNeedsReasonNotice();
          haptics.warning();
          toast({ message: notice.message, kind: notice.kind });
          navigate({
            pathname: PUSH_REJECT_ROUTE,
            params: pushRejectRouteParams(entityId),
          });
          return true;
        }
        notes = plan.notes;
      }

      if (
        !(await deviceOwnerPresent(
          decision === "approve"
            ? "Confirm it's you to approve this request"
            : "Confirm it's you to reject this request",
        ))
      ) {
        if (cancelled) return true;
        haptics.warning();
        toast({
          kind: "warning",
          message: "Unlock Moosewave to decide this request. Nothing was sent.",
        });
        // Handled, so a cold-start response is consumed: re-offering the same
        // decision on the next launch would re-open the bypass rather than
        // rescue anything, and the request is still waiting in Approvals.
        return true;
      }

      const copy = pushDecisionConfirmCopy(decision, notes);
      const confirmed = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        cancelLabel: copy.cancelLabel,
        destructive: copy.destructive,
      });
      if (!confirmed || cancelled) return true;

      const ok = await decideApprovalFromNotification(
        entityId,
        decision,
        notes,
      );
      if (cancelled) return true;
      // Refresh the approvals queries (pending list + tab badge) regardless of
      // outcome: success moves the row out of pending, and an
      // already-decided/expired failure also means our cached copy is stale.
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      const outcome = pushDecisionOutcomeNotice({
        ok,
        online: isProbablyOnline(),
        decision,
      });
      toast({ message: outcome.message, kind: outcome.kind });
      return true;
    }

    async function revokeSecuritySession(
      sessionId: string,
      retryable: boolean,
    ): Promise<boolean> {
      const auth = useAuthStore.getState();
      const gate = securitySessionRevokeGate({
        mode: auth.mode,
        canUseOnlineServices: auth.canUseOnlineServices(),
        sessionValidation: auth.sessionValidation,
        retryable,
      });
      if (gate === "retry_later") return false;
      if (gate !== "confirm" || !auth.baseUrl || !auth.session) {
        haptics.warning();
        toast({
          kind: "warning",
          message:
            gate === "session_required"
              ? "Sign in with your account to review and revoke this session."
              : "Reconnect, then review Active devices before revoking this session.",
        });
        navigate(SECURITY_REVIEW_ROUTE);
        return true;
      }

      if (
        !(await deviceOwnerPresent("Confirm it's you to revoke this session"))
      ) {
        if (cancelled) return true;
        haptics.warning();
        toast({
          kind: "warning",
          message:
            "Unlock Moosewave to revoke this session. Nothing was changed.",
        });
        return true;
      }

      // Capture the authority that owns the confirmation. If the user changes
      // workspace/account while the sheet is open, the answer must not mutate
      // against the newly-selected identity.
      const authority = {
        baseUrl: auth.baseUrl,
        tenantId: auth.session.tenantId,
        userId: auth.session.userId,
      };
      const confirmed = await confirm({
        title: "Revoke this new session?",
        message:
          "This immediately signs out only the session named by this security alert. If it was yours, that device will need to sign in again.",
        confirmLabel: "Revoke session",
        cancelLabel: "Keep session",
        destructive: true,
      });
      if (!confirmed || cancelled) return true;

      const current = useAuthStore.getState();
      if (
        current.mode !== "session" ||
        !current.canUseOnlineServices() ||
        current.baseUrl !== authority.baseUrl ||
        current.session?.tenantId !== authority.tenantId ||
        current.session?.userId !== authority.userId
      ) {
        haptics.warning();
        toast({
          kind: "warning",
          message:
            "Your active account changed. Review Active devices before revoking anything.",
        });
        navigate(SECURITY_REVIEW_ROUTE);
        return true;
      }

      const result = await revokeSession(authority.baseUrl, sessionId);
      if (cancelled) return true;
      void queryClient.invalidateQueries({ queryKey: ["auth-sessions"] });
      if (result.error) {
        if (result.error.status === 404) {
          toast({
            kind: "info",
            message:
              "That session is already signed out or no longer available.",
          });
        } else {
          haptics.error();
          toast({
            kind: "error",
            message:
              "Couldn't revoke that session. Review Active devices and try again.",
          });
        }
        return true;
      }
      haptics.success();
      toast({ kind: "success", message: "The new session was revoked." });
      return true;
    }

    async function handleResponse(
      response: Notifications.NotificationResponse | null | undefined,
      retryable: boolean,
    ): Promise<boolean> {
      if (!response) return true;
      const action = parseNotificationAction(response);
      const securitySessionId = securitySessionRevokeTarget(action);
      if (securitySessionId) {
        return revokeSecuritySession(securitySessionId, retryable);
      }
      const decision = decisionFor(action?.actionIdentifier);
      if (decision && action?.entityId) {
        return decide(decision, action.entityId, retryable, action.userText);
      }
      // Default tap or "View": route to the entity.
      const target = routeForNotification(response);
      if (!cancelled && target) navigate(target);
      return true;
    }

    void (async () => {
      if (coldNotificationConsumed.current) return;
      const cold = await lastNotificationResponse();
      if (cancelled || coldNotificationConsumed.current) return;
      // Consume ONLY once actually handled: a decision arriving while the
      // cached session is still "checking" returns false, and leaving the
      // response unconsumed lets this effect re-run (sessionValidation dep)
      // and process it once validation settles.
      const consumed = await handleResponse(cold, true);
      if (consumed) coldNotificationConsumed.current = true;
    })();

    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        void handleResponse(response, false);
      },
    );
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [hydrated, canEnterApp, sessionValidation, confirm, toast, navigate]);
}
