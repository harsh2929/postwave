/**
 * lib/pushDecisionFlow.ts — the PURE rules behind deciding an approval from a
 * notification action button, i.e. the killed-app "Approve" path.
 *
 * SHELL#72 / NATIVE#37. The root layout used to hand-roll this as a Promise
 * around `Alert.alert`, then stack a SECOND `Alert` across three outcome
 * branches — up to three OS modals from one push, in an app that ships a
 * themed confirm sheet, an accessible toast, and semantic haptics. Moving the
 * DECISIONS here leaves the layout with presentation only, and makes the parts
 * that are easy to get wrong testable in the node environment.
 *
 * The authorization fact this encodes, read from the handler and not from the
 * route manifest: `POST /api/v1/approvals/{id}/approve` and `.../reject` both
 * call `requireAdmin` (apps/api/internal/approvals/handlers.go — `decide` at
 * :297 and `decideReturningApproval` at :353), which admits only owner|admin
 * and 403s everyone else. It is a ROLE gate, not a scope gate, so mobile
 * models it with `canAccessMobileCapability("approvals_decide", …)`.
 *
 * Import-free apart from that role table (which is itself react-native-free).
 */
import { canAccessMobileCapability } from "@/lib/mobileRouteManifest";

export type PushApprovalDecision = "approve" | "reject";

/**
 * What to do with an approve/reject action before touching the network.
 *
 *  - `retry_later`  the cached session is mid-/me-revalidation and this is a
 *                   COLD-START response we can re-read. Leave it unconsumed so
 *                   the effect re-runs once validation settles rather than
 *                   dropping a decision or nagging about being offline.
 *  - `blocked_role` this account cannot decide approvals. Say so instead of
 *                   POSTing a guaranteed 403 and then blaming it on the
 *                   request having "already been decided or expired".
 *  - `offline`      genuinely offline: the POST cannot leave the device.
 *  - `confirm`      ask, then send.
 */
export type PushDecisionGate =
  | { kind: "retry_later" }
  | { kind: "blocked_role" }
  | { kind: "offline" }
  | { kind: "confirm" };

export interface PushDecisionGateInput {
  /** `useAuthStore.getState().canUseOnlineServices()`. */
  canUseOnlineServices: boolean;
  /** `sessionValidation` — "checking" means authenticated AND reaching out. */
  sessionValidation: string;
  /** True only for a cold-start response, which can be re-read next run. */
  retryable: boolean;
  /** Session role, e.g. "owner". Ignored in api_key mode (see below). */
  role: string | null | undefined;
  mode: "api_key" | "session" | null | undefined;
}

export function pushDecisionGate(input: PushDecisionGateInput): PushDecisionGate {
  if (!roleMayDecide(input.role, input.mode)) return { kind: "blocked_role" };
  if (input.canUseOnlineServices) return { kind: "confirm" };
  if (input.sessionValidation === "checking") {
    // Authenticated and reaching the network — not offline. Defer a cold-start
    // response; attempt a live one, which only needs an authenticated session.
    return input.retryable ? { kind: "retry_later" } : { kind: "confirm" };
  }
  return { kind: "offline" };
}

/**
 * API-key sessions are deliberately NOT role-gated here. `requireAdmin`
 * short-circuits to allow for API-key auth (the scope check already ran in
 * middleware), and the phone never sees a key's scopes — so refusing locally
 * would remove a path that actually works on the server. Session users get the
 * real owner|admin floor.
 */
export function roleMayDecide(
  role: string | null | undefined,
  mode: "api_key" | "session" | null | undefined,
): boolean {
  if (mode === "api_key") return true;
  return canAccessMobileCapability("approvals_decide", role, mode);
}

export interface PushDecisionConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
}

/**
 * The confirm sheet shown before an irreversible decision.
 *
 * When a reject carries the reason the OS collected, the sheet ECHOES it. The
 * text was typed into a lock-screen field the approver can no longer see by the
 * time this sheet is up, and it is about to be written to an audit row the
 * requester reads — so the last chance to notice a typo or a wrong-request
 * mix-up is here.
 */
export function pushDecisionConfirmCopy(
  decision: PushApprovalDecision,
  notes?: string,
): PushDecisionConfirmCopy {
  const verb = decision === "approve" ? "Approve" : "Reject";
  const reason = (notes ?? "").trim();
  return {
    title: `${verb} this request?`,
    message: reason
      ? `The requester will see: "${reason}". This decision is recorded immediately.`
      : "Open Approvals first if you need to review more context. This decision is recorded immediately.",
    confirmLabel: verb,
    cancelLabel: "Cancel",
    destructive: decision === "reject",
  };
}

/**
 * GOVERNANCE#37 — A REJECTION WITHOUT A REASON IS A GOVERNANCE HOLE.
 *
 * Every in-app rejection carries one. `app/(tabs)/approvals/[id].tsx` and
 * `hooks/useApprovalDecisions.ts` both route reject through
 * `rejectDraftSubmitState`, which returns `reason_required` for an empty
 * string and REFUSES to build a request — so the requester always learns why.
 * The notification button was the one door out of that rule: it POSTed
 * `{decision:"reject"}` with no `notes` at all, and the requester got a bare
 * rejection. Same decision, same audit row, no explanation — purely because
 * the approver used the lock screen instead of the screen.
 *
 * The fix keeps the fast path fast. The OS action itself now collects the
 * reason (`textInput` on the Reject action, `lib/pushPresentation.ts`), which
 * arrives back as `NotificationResponse.userText`. When that text is usable the
 * decision goes straight through WITH its notes. When it is not — an empty
 * submit, a platform that gave us no field, a pathological length — we do not
 * silently fall back to a reasonless POST. We send the approver to the request,
 * where the mandatory-reason sheet is waiting.
 *
 * Approve is deliberately untouched: there is no equivalent rule for it.
 */

/**
 * Long enough for any real explanation typed into a lock-screen field, short
 * enough that the value can never be a payload. The in-app sheet has no cap of
 * its own (the server bounds the whole body at 64 KiB), so this is a bound on
 * THIS door only, and exceeding it routes into the app rather than truncating —
 * silently sending half of someone's stated reason is worse than asking again.
 */
export const MAX_PUSH_REJECT_REASON_CHARS = 500;

/**
 *  - `submit`       the approver typed a usable reason; POST it as `notes`.
 *  - `needs_reason` no usable reason reached us. Open the request so the
 *                   in-app reject sheet can enforce the rule.
 */
export type PushRejectPlan =
  | { kind: "submit"; notes: string }
  | { kind: "needs_reason" };

/**
 * What to do with the text (if any) the OS collected alongside a Reject action.
 * Pure, so the rule that governs an irreversible decision is testable without a
 * device, an OS dialog or a React tree.
 */
export function pushRejectPlan(
  userText: string | null | undefined,
): PushRejectPlan {
  if (typeof userText !== "string") return { kind: "needs_reason" };
  const notes = userText.trim();
  if (!notes) return { kind: "needs_reason" };
  if (notes.length > MAX_PUSH_REJECT_REASON_CHARS) {
    return { kind: "needs_reason" };
  }
  return { kind: "submit", notes };
}

/**
 * The toast shown when a reject arrives without a reason and we route into the
 * app instead of deciding. It has to explain WHY the button did not just work —
 * an approver who taps Reject and lands on a screen with no explanation reads
 * that as a bug, not as a rule.
 */
export function pushRejectNeedsReasonNotice(): PushDecisionNotice {
  return {
    message: "Add a reason to reject — the requester needs to know what to fix.",
    kind: "warning",
  };
}

/**
 * Where a reasonless reject goes instead: the request's own detail screen, with
 * the reject sheet already open. Not the queue — the approver has already told
 * us which request they mean, and making them find it again is how a governance
 * rule turns into a thing people route around.
 */
export const PUSH_REJECT_ROUTE = "/(tabs)/approvals/[id]";

/**
 * The param the detail screen watches to auto-open its reject sheet. A string
 * because it travels through the router's query params, which are strings.
 */
export const PUSH_REJECT_PARAM = "reject";

export function pushRejectRouteParams(
  entityId: string,
): Record<string, string> {
  return { id: entityId, [PUSH_REJECT_PARAM]: "1" };
}

export interface PushDecisionNotice {
  message: string;
  kind: "success" | "error" | "warning";
}

/** The single toast that replaces the three stacked outcome alerts. */
export function pushDecisionOutcomeNotice(input: {
  ok: boolean;
  online: boolean;
  decision: PushApprovalDecision;
}): PushDecisionNotice {
  if (input.ok) {
    return {
      message:
        input.decision === "approve" ? "Request approved." : "Request rejected.",
      kind: "success",
    };
  }
  if (!input.online) {
    // The POST failed with the device offline — it never reached the server,
    // so do not misattribute this to "already decided or expired".
    return {
      message:
        "You're offline, so the decision wasn't sent. Open Approvals once you reconnect.",
      kind: "error",
    };
  }
  return {
    message:
      "Couldn't record that — the request may already have been decided or expired. Open Approvals to check.",
    kind: "error",
  };
}

/** Copy for the two gates that stop before the network. */
export function pushDecisionBlockedNotice(
  gate: PushDecisionGate["kind"],
): PushDecisionNotice | null {
  if (gate === "offline") {
    return {
      message:
        "You're offline. Open Approvals after reconnecting to approve or reject this request.",
      kind: "warning",
    };
  }
  if (gate === "blocked_role") {
    return {
      message:
        "Deciding approvals requires an owner or admin role in this workspace.",
      kind: "error",
    };
  }
  return null;
}
