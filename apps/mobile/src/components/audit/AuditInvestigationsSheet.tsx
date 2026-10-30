/**
 * AuditInvestigationsSheet — read and decide the AI investigation queue.
 *
 * Desktop has a whole page for this (apps/desktop/src/pages/
 * AuditInvestigation.tsx). Mobile mounts it as a sheet over the audit log
 * rather than as its own route, and that is a decision, not a shortcut: an
 * investigation is anchored to an audit row (`seed_audit_id`), so it belongs
 * to the log surface, and a sheet keeps the queue one tap from the evidence
 * instead of one navigation away from it.
 *
 * THE STATUS STREAM IS A TRIGGER, NOT A FEED. This header used to claim RN
 * could not consume `GET /audit/investigations/{id}/stream` at all — the same
 * stale transport claim lib/auditTail corrects (the app streams through
 * `expo/fetch`; see api/sseConnect). While the sheet is open and a
 * still-mutable investigation exists, one focus-gated socket re-reads the
 * LIST on each transition frame (useInvestigationStreamTrigger); nothing
 * from the wire reaches a render path, and every failure mode falls back to
 * exactly the pull-to-refresh that shipped before it.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *  - NO "INVESTIGATE THIS ROW" TRIGGER. POST /api/v1/audit/{id}/investigate
 *    runs the agent synchronously against an LLM and can take a long time; a
 *    phone that backgrounds mid-request would leave the operator with no idea
 *    whether it ran. Reviewing the queue is the phone-shaped half.
 *  - NO PER-ACTION APPROVAL. The server answers 422
 *    partial_approval_unsupported for `action_ids`; offering checkboxes would
 *    invent a capability.
 */
import { useCallback } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { QueryStates } from "@/components/QueryStates";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SkeletonList } from "@/components/Skeleton";
import { useTickingNow } from "@/hooks/useTickingNow";
import { useInvestigationStreamTrigger } from "@/hooks/useAuditInvestigations";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import {
  INVESTIGATION_NO_EXECUTION_NOTE,
  isInvestigationDecidable,
  streamableInvestigationId,
  type AuditInvestigation,
} from "@/lib/auditInvestigations";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditInvestigationCard } from "./AuditInvestigationCard";
import { SheetHeader } from "./AuditSheetParts";

/**
 * The header trigger, with the count of drafts awaiting review.
 *
 * The count is the reason this control earns a permanent slot: "3 awaiting
 * review" is a queue depth, and a governance queue nobody can see is a queue
 * nobody works. It renders no number at all while the list is unknown —
 * a "0" on an unloaded query would be a false all-clear.
 */
export function AuditInvestigationsButton({
  onPress,
  pending,
}: {
  onPress: () => void;
  /** Drafts awaiting review, or null when not yet known. */
  pending: number | null;
}) {
  const { t } = useTheme();
  const badge = pending !== null && pending > 0 ? ` (${pending})` : "";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        pending === null
          ? "AI investigations"
          : `AI investigations, ${pending} awaiting review`
      }
      accessibilityHint="Opens the investigation review queue"
      hitSlop={8}
      style={{
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 6,
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: pending !== null && pending > 0 ? t.accent : t.fgMuted,
          ...typeStyle("callout"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {`AI${badge}`}
      </Text>
    </Pressable>
  );
}

export interface AuditInvestigationsSheetProps {
  visible: boolean;
  onClose: () => void;
  investigations: AuditInvestigation[] | undefined;
  loading: boolean;
  /** The list query's isPending/isPaused: a paused first fetch is offline. */
  isPending: boolean;
  isPaused: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
  refreshing: boolean;
  /** Owner/admin — the decide routes are gated on apikeys.ScopeAdmin. */
  canDecide: boolean;
  decidingId: string | null;
  onApprove: (inv: AuditInvestigation) => void;
  onReject: (inv: AuditInvestigation) => void;
}

export function AuditInvestigationsSheet(props: AuditInvestigationsSheetProps) {
  const offlineGate = useOnlineQueryGate();
  const { t } = useTheme();
  const rows = props.investigations ?? [];
  const now = useTickingNow(props.visible);
  // One live socket on the newest still-mutable investigation; each status
  // transition re-reads the list. See the header — a trigger, never a feed.
  useInvestigationStreamTrigger({
    enabled: props.visible,
    investigationId: streamableInvestigationId(rows),
    refetch: props.refetch,
  });

  const renderActions = useCallback(
    (inv: AuditInvestigation) => {
      if (!isInvestigationDecidable(inv)) return null;
      if (!props.canDecide) {
        return (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Deciding an investigation is limited to workspace owners and admins.
          </Text>
        );
      }
      const busy = props.decidingId === inv.id;
      return (
        <View style={{ gap: 8 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {INVESTIGATION_NO_EXECUTION_NOTE}
          </Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <DecisionButton
              label="Reject"
              busyLabel="Rejecting…"
              busy={busy}
              tone="danger"
              onPress={() => props.onReject(inv)}
            />
            <DecisionButton
              label="Approve"
              busyLabel="Approving…"
              busy={busy}
              tone="accent"
              onPress={() => props.onApprove(inv)}
            />
          </View>
        </View>
      );
    },
    [props, t],
  );

  return (
    <ReducedMotionModal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="AI investigations"
      >
        <SheetHeader title="AI investigations" onClose={props.onClose} />
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 12 }}
          refreshControl={
            <RefreshControl
              refreshing={props.refreshing}
              onRefresh={() => void props.refetch()}
              tintColor={t.fgMuted}
              colors={[t.accent]}
            />
          }
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            The investigator agent correlates a window around a suspicious audit
            event and proposes a remediation plan for a human to accept or
            decline. While this sheet is open, status changes stream in; pull
            to refresh any time.
          </Text>
          <QueryStates
            query={{
              isError: props.isError,
              isLoading: props.loading,
              isPending: props.isPending,
              isPaused: props.isPaused,
              error: props.error,
              refetch: props.refetch,
            }}
            isEmpty={rows.length === 0}
            gate={offlineGate}
            offlineMessage={"Investigations need a connection. Nothing has been loaded on this device yet."}
            empty={{
              title: "No investigations",
              description:
                "Nothing has been raised for review. Investigations are created from the audit log on a desktop or by the agent itself.",
            }}
            skeleton={<SkeletonList rows={3} />}
          >
            {rows.map((inv) => (
              <View key={inv.id} style={{ marginBottom: 12 }}>
                <AuditInvestigationCard
                  investigation={inv}
                  now={now}
                  actions={renderActions(inv)}
                />
              </View>
            ))}
          </QueryStates>
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function DecisionButton({
  label,
  busyLabel,
  busy,
  tone,
  onPress,
}: {
  label: string;
  busyLabel: string;
  busy: boolean;
  tone: "danger" | "accent";
  onPress: () => void;
}) {
  const { t } = useTheme();
  const isDanger = tone === "danger";
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`${label} this remediation plan`}
      accessibilityState={{ disabled: busy, busy }}
      style={{
        flex: 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: isDanger ? 1 : 0,
        borderColor: t.danger,
        backgroundColor: isDanger ? "transparent" : t.accent,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: isDanger ? t.danger : t.accentFg,
          ...typeStyle("control"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {busy ? busyLabel : label}
      </Text>
    </Pressable>
  );
}
