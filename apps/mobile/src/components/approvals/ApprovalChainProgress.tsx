/**
 * ApprovalChainProgress — where this request is in a multi-stage gate.
 *
 * When a request needs Legal, then Finance, then a VP, the phone approver's
 * first question is "am I the blocker, or is somebody ahead of me?" — and
 * until now neither client answered it, though the server computes it
 * (apps/api/internal/approvals/chain.go).
 *
 * The ladder is deliberately a LIST OF SENTENCES rather than a row of dots.
 * Dots encode state in colour alone, which fails the app's accessibility bar
 * and is unreadable on a phone in daylight anyway. Each stage names itself,
 * its role and its state in words; colour is decoration on top of that.
 *
 * Renders nothing when no chain is configured — the overwhelmingly common
 * case is a single-gate approval, and an empty "chain" heading on every one
 * of those would be noise that teaches people to ignore the section.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  APPROVAL_CHAIN_RECONFIGURED_NOTE,
  approvalChainHeadline,
  approvalChainStageLabel,
  type ApprovalChainStage,
  type ApprovalChainView,
} from "@/lib/approvalChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ApprovalChainProgressProps {
  view: ApprovalChainView;
  loading: boolean;
  /** The reader's own workspace role, for the "that's you" line. */
  viewerRole: string | null | undefined;
}

export function ApprovalChainProgress({
  view,
  loading,
  viewerRole,
}: ApprovalChainProgressProps) {
  const { t } = useTheme();
  // Absence is not "no chain": while either read is in flight the section
  // stays away rather than asserting there are no stages ahead.
  if (loading || !view.configured) return null;
  const headline = approvalChainHeadline(view, viewerRole);
  if (!headline) return null;

  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
        padding: 14,
        gap: 10,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontWeight: "700",
          fontFamily: FONT.semibold,
          letterSpacing: 0.4,
        }}
      >
        APPROVAL CHAIN
      </Text>
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
        }}
      >
        {headline}
      </Text>
      <View style={{ gap: 6 }}>
        {view.stages.map((stage) => (
          <StageLine key={stage.position} stage={stage} />
        ))}
      </View>
      {view.reconfigured ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {APPROVAL_CHAIN_RECONFIGURED_NOTE}
        </Text>
      ) : null}
    </View>
  );
}

function StageLine({ stage }: { stage: ApprovalChainStage }) {
  const { t } = useTheme();
  const tone =
    stage.status === "approved"
      ? t.success
      : stage.status === "rejected"
        ? t.danger
        : stage.current
          ? t.accent
          : t.fgSubtle;
  return (
    <View
      accessible
      accessibilityLabel={approvalChainStageLabel(stage)}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          marginTop: 6,
          backgroundColor: tone,
        }}
      />
      <Text
        {...typeCap("bodySmall")}
        style={{
          flex: 1,
          color: stage.current ? t.fg : t.fgMuted,
          ...typeStyle("bodySmall"),
          fontWeight: stage.current ? "600" : "400",
          fontFamily: stage.current ? FONT.semibold : FONT.regular,
        }}
      >
        {approvalChainStageLabel(stage)}
      </Text>
    </View>
  );
}
