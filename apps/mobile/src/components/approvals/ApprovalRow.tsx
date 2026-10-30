/**
 * ApprovalRow — one approval card in the queue.
 *
 * Lives in its own file (rather than inline in the screen) because it calls
 * a hook per row — `useApprovalResourceContext` resolves what the approval
 * is actually gating, so the approver sees "Spring sale · 12,480 recipients"
 * instead of an opaque UUID.
 *
 * Interaction model:
 *   - Tap  → the detail route. Reading before deciding is the default path.
 *   - Swipe → Approve / Reject, for clearing a queue at speed. The gesture is
 *     deliberate enough to stand in for a confirm dialog, and SwipeableRow
 *     republishes both as VoiceOver rotor actions, so screen-reader users gain
 *     an affordance rather than losing one.
 *
 *     THE TWO VERBS SIT ON OPPOSITE EDGES. They shipped stacked in one
 *     right-hand panel: two 84pt buttons, adjacent, one of them irreversible,
 *     distinguished only by colour and a five-letter word — the exact mis-tap
 *     the panel's own `danger` haptic exists to confess after the fact. Split,
 *     the direction of the drag IS the decision (the mail-app idiom: pull from
 *     the left edge to accept, from the right to refuse), and reaching Reject
 *     can no longer happen by overshooting Approve. The rotor is unaffected —
 *     SwipeableRow publishes `[...left, ...right]`, so both verbs stay in it.
 *
 * A row that cannot be decided (expired, self-requested, offline, or a
 * decision already in flight) is disabled with the reason spoken, not
 * silently inert.
 */
import { memo, useRef } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SwipeableRow, type SwipeAction } from "@/components/SwipeableRow";
import type { Approval } from "@/hooks/useApprovals";
import { useApprovalResourceContext } from "@/hooks/useApprovals";
import { plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  approvalRowDecisionState,
  approvalRowNotices,
  expiryHint,
  isApprovalExpired,
  requestedAtLine,
  resourceLabel,
  type ApprovalGateNotice,
} from "./approvalPresentation";

/** Module-level so a non-decidable row is not two new array identities. */
const NO_DECIDE_ACTIONS: { left: SwipeAction[]; right: SwipeAction[] } = {
  left: [],
  right: [],
};

export function statusTone(
  status: Approval["status"],
): "warning" | "success" | "danger" | "neutral" {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  if (status === "expired") return "neutral";
  return "warning";
}

/** Resource ids are UUIDs; 8 chars identify a row without wrapping. */
export function shortId(s: string): string {
  if (!s) return "—";
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…`;
}

export interface ApprovalRowProps {
  approval: Approval;
  decidingId: string | null;
  anyDeciding: boolean;
  gateNotice: ApprovalGateNotice;
  /** Ticking clock so the countdown ages and the row self-disables. */
  now: number;
  /** Signed-in user, for the no-self-approval pre-check. */
  currentUserId: string | null;
  onOpen: (approval: Approval) => void;
  /**
   * LOVE#75. The third argument is the ROW's own node, handed to the sheet
   * that opens so screen-reader focus comes back here on dismiss instead of
   * being dropped at the top of the queue. It is the row rather than a button
   * because the decide affordances on this surface are the swipe actions,
   * which VoiceOver surfaces as accessibility actions ON the row.
   */
  onApprove: (
    approval: Approval,
    label: string,
    rowRef: { current: unknown },
  ) => void;
  onReject: (
    approval: Approval,
    label: string,
    rowRef: { current: unknown },
  ) => void;
}

function ApprovalRowImpl({
  approval: a,
  decidingId,
  anyDeciding,
  gateNotice,
  now,
  currentUserId,
  onOpen,
  onApprove,
  onReject,
}: ApprovalRowProps) {
  const { t } = useTheme();
  const ctx = useApprovalResourceContext(a);
  // One ref PER ROW: React Native cannot report which element holds VoiceOver
  // focus, so "put it back where it was" has to be plumbed explicitly, and a
  // single shared ref would send every dismissal to the same row.
  const rowRef = useRef<View>(null);

  const typeLabel = resourceLabel(a.resourceType);
  const headline = ctx.title ?? `${typeLabel} · ${shortId(a.resourceId)}`;
  const decideLabel = ctx.title
    ? `${typeLabel} · ${ctx.title}`
    : `${typeLabel} · ${shortId(a.resourceId)}`;

  const requestedBy =
    a.requestedByActorLabel ||
    (a.requestedByActorType ? `via ${a.requestedByActorType}` : "unknown");
  const isPending = a.status === "pending";
  const isRowDeciding = decidingId === a.id;
  const isExpired = isApprovalExpired(a.expiresAt, now);
  const isOwnRequest = Boolean(
    currentUserId && a.requestedByUserId && a.requestedByUserId === currentUserId,
  );
  const isAgentInitiated = a.requestedByActorType === "agent";

  const base = approvalRowDecisionState({
    isPending,
    isRowDeciding,
    gateNotice,
    isExpired,
    isOwnRequest,
  });
  // One global in-flight flag guards the decide mutation, so while ANY row is
  // being decided every other pending row would silently swallow taps. Dim
  // and disable them for that window instead of looking live and doing nothing.
  const decisionState =
    anyDeciding && isPending && !base.disabled
      ? { ...base, disabled: true, opacity: 0.6 }
      : base;
  const notices = approvalRowNotices({ isPending, isExpired, isOwnRequest });

  const contextBits: string[] = [typeLabel];
  if (typeof ctx.recipients === "number" && ctx.recipients > 0) {
    contextBits.push(plural(ctx.recipients, "recipient"));
  }
  if (ctx.status) contextBits.push(ctx.status);

  const expiry = isPending ? expiryHint(a.expiresAt, now) : "";
  const canSwipeDecide = !decisionState.disabled;
  // ONE branch, not two: the pair is a single decision ("may this row be
  // decided?"), and splitting it across the `left` and `right` props put this
  // component over its cyclomatic budget for a fact it already knew.
  const decideActions: { left: SwipeAction[]; right: SwipeAction[] } =
    canSwipeDecide
      ? {
          left: [
            {
              label: "Approve",
              kind: "success",
              onPress: () => onApprove(a, decideLabel, rowRef),
            },
          ],
          right: [
            {
              label: "Reject",
              kind: "danger",
              onPress: () => onReject(a, decideLabel, rowRef),
            },
          ],
        }
      : NO_DECIDE_ACTIONS;

  const card = (
    <Pressable
      ref={rowRef}
      onPress={() => onOpen(a)}
      accessibilityRole="button"
      accessibilityLabel={`${headline}, ${typeLabel}, ${a.status}${decisionState.accessibilityLabelSuffix}`}
      accessibilityHint="Opens the full request"
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        opacity: decisionState.opacity,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flex: 1,
          }}
          {...typeCap("body")}
          numberOfLines={2}
        >
          {headline}
        </Text>
        <Pill label={a.status} tone={statusTone(a.status)} />
      </View>

      {ctx.subtitle ? (
        <Text
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
          {...typeCap("label")}
          numberOfLines={1}
        >
          {ctx.subtitle}
        </Text>
      ) : null}

      {/* What is being approved, at what scale — not just an id. */}
      <Text
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
        {...typeCap("label")}
        numberOfLines={1}
      >
        {ctx.loading ? "Loading details…" : contextBits.join(" · ")}
      </Text>

      <Text
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
        {...typeCap("label")}
        numberOfLines={2}
      >
        Requested by {requestedBy}
        {a.notes ? ` — ${a.notes}` : ""}
      </Text>

      {notices.length > 0 || isAgentInitiated ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 8,
          }}
        >
          {isAgentInitiated ? <Pill label="AI-initiated" tone="info" /> : null}
          {notices.map((n) => (
            <Pill key={n.key} label={n.label} tone={n.tone} />
          ))}
        </View>
      ) : null}

      {requestedAtLine(a.requestedAt, now) ? (
        <Text
          style={{
            color: t.fgSubtle,
            ...typeStyle("numeric"),
            marginTop: 6,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
          {...typeCap("numeric")}
          numberOfLines={1}
        >
          {requestedAtLine(a.requestedAt, now)}
        </Text>
      ) : null}
      {expiry && !isExpired ? (
        <Text
          style={{
            color: t.warning,
            ...typeStyle("badgeSmall"),
            marginTop: 4,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
          {...typeCap("badgeSmall")}
          numberOfLines={1}
        >
          {expiry}
        </Text>
      ) : null}
      {isRowDeciding ? (
        <Text
          style={{
            color: t.fgMuted,
            ...typeStyle("badgeSmall"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
          {...typeCap("badgeSmall")}
          numberOfLines={1}
        >
          Deciding…
        </Text>
      ) : null}
    </Pressable>
  );

  return (
    <View style={{ marginBottom: 8 }}>
      <SwipeableRow
        enabled={canSwipeDecide}
        accessibilityLabel={`${headline}, ${a.status}`}
        left={decideActions.left}
        right={decideActions.right}
      >
        {card}
      </SwipeableRow>
    </View>
  );
}

export const ApprovalRow = memo(ApprovalRowImpl);
