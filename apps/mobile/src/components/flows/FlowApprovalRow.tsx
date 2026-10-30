/**
 * FlowApprovalRow — one parked `manual_review` gate, and the two buttons that
 * unpark it.
 *
 * THE ROW DELIBERATELY DOES NOT NAME A FLOW, AND THAT IS THE HARDEST THING
 * ABOUT THIS SURFACE. The handler's SELECT (flow_approvals.go:44) returns
 * `automation_id` and never `journey_id`, and the engine's gate only ever
 * writes `automation_id` — but flow-builder flows are rows in
 * `automation_journeys`, a different table. So the id on this row will not
 * match any flow in the list beside it, and rendering a flow name next to it
 * would attach a stranger's flow to somebody's review. The row names what it
 * actually knows: the step, the channel, and the automation id.
 *
 * BOTH BUTTONS ARE ROLE-GATED BEFORE THEY ARE PRESSED. `POST .../approve` and
 * `.../reject` are wrapped in `RequireScope(ScopeWriteCampaigns)`, which on
 * the session path admits owner, admin and editor (`editorWriteScopes`,
 * apikeys/middleware.go:291). A viewer is told plainly instead of typing
 * through a confirm sheet to reach a 403.
 *
 * DECIDED ROWS KEEP THEIR BUTTONS HIDDEN, driven by `isDecidable` — the exact
 * predicate `Repo.Decide` updates on. A row the server would 409 never offers
 * an action.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { dateTime, EMDASH, relativeTime, truncateMiddle } from "@/lib/format";
import {
  approvalChannelLabel,
  approvalStatusPresentation,
  isDecidable,
  type FlowApprovalDecision,
  type MobileFlowApproval,
} from "@/lib/flowApprovals";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface FlowApprovalRowProps {
  approval: MobileFlowApproval;
  now: number;
  /** False for viewers: deciding is editor-minimum server-side. */
  canDecide: boolean;
  /** False offline: a decision is final and is never queued for later. */
  online: boolean;
  /** True while THIS row's decision is in flight. */
  busy: boolean;
  onDecide: (approval: MobileFlowApproval, decision: FlowApprovalDecision) => void;
}

function FlowApprovalRowImpl({
  approval,
  now,
  canDecide,
  online,
  busy,
  onDecide,
}: FlowApprovalRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();

  const status = approvalStatusPresentation(approval.transactionalStatus);
  const decidable = isDecidable(approval);

  // `requested_at` is nullable, and `created_at` is the row's birth rather
  // than the moment a review was asked for. Neither is invented from the
  // other; when both are absent the answer is an em-dash.
  const waitingSince = approval.requestedAt ?? approval.createdAt;
  const waited = waitingSince
    ? `Waiting since ${relativeTime(waitingSince, { now })}`
    : `Waiting since ${EMDASH}`;
  const waitedSpoken = waitingSince
    ? `Waiting since ${dateTime(waitingSince)}`
    : "The time it started waiting was not recorded.";

  const decided = approval.decidedAt
    ? `Decided ${relativeTime(approval.decidedAt, { now })}`
    : null;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: decidable ? t.warning : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        gap: 6,
        opacity: busy ? 0.55 : 1,
      }}
    >
      <View
        accessible
        accessibilityLabel={`Review at step ${
          approval.nodeId || "unnamed"
        }. ${approvalChannelLabel(approval.channel)}. ${status.spoken} ${
          decided ?? waitedSpoken
        }`}
        style={{ gap: 6 }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            numberOfLines={maxLinesAtScale(2, fontScale)}
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
              flexShrink: 1,
            }}
          >
            {approval.nodeId || "Unnamed step"}
          </Text>
          <Pill
            label={status.label}
            tone={status.tone}
            accessibilityLabel={status.spoken}
          />
        </View>

        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {approvalChannelLabel(approval.channel)} {EMDASH}{" "}
          {decided ?? waited}
        </Text>

        {/* The one identifier this endpoint gives us. Middle-truncated so a
            uuid does not eat the row, with the full value spoken above. */}
        <Text
          numberOfLines={1}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {approval.automationId
            ? `Automation ${truncateMiddle(approval.automationId, 16)}`
            : "No automation recorded"}
        </Text>
      </View>

      {decidable ? (
        <DecisionButtons
          canDecide={canDecide}
          online={online}
          busy={busy}
          onApprove={() => onDecide(approval, "approve")}
          onReject={() => onDecide(approval, "reject")}
        />
      ) : null}
    </View>
  );
}

function DecisionButtons({
  canDecide,
  online,
  busy,
  onApprove,
  onReject,
}: {
  canDecide: boolean;
  online: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTheme();

  if (!canDecide) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        Read-only for your role — deciding a review needs an editor or higher.
      </Text>
    );
  }

  if (!online) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        {"You're offline. A decision is final and cannot be undone, so it is never queued for later — reconnect to decide this."}
      </Text>
    );
  }

  return (
    <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
      <DecisionButton
        label="Reject"
        tone={t.danger}
        busy={busy}
        onPress={onReject}
        hint="Ends this branch of the flow for the subscribers waiting on it"
      />
      <DecisionButton
        label="Approve"
        tone={t.success}
        busy={busy}
        onPress={onApprove}
        hint="Lets the parked flow continue past this step"
      />
    </View>
  );
}

function DecisionButton({
  label,
  tone,
  busy,
  onPress,
  hint,
}: {
  label: string;
  tone: string;
  busy: boolean;
  onPress: () => void;
  hint: string;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: busy, busy }}
      style={{
        flex: 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tone,
        backgroundColor: t.surface,
        paddingHorizontal: 12,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: tone,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export const FlowApprovalRow = memo(FlowApprovalRowImpl);
