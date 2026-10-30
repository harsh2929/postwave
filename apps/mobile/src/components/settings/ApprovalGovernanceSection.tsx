/**
 * ApprovalGovernanceSection — escalation policy + who currently holds approvals.
 *
 * Approvals is one of five bottom tabs and the app ships an actionable-push
 * approve/reject flow, but the governance half lived only on desktop. Both
 * endpoints have shipped since the approvals service landed.
 *
 * Scope: reading the active delegations, revoking one, and — since GATE#11 — CREATING
 * one. The old note here said a picker "is not buildable on mobile yet" because the
 * API exposed no workspace-members listing. That went stale:
 * GET /api/v1/workspace/members is mounted (handlers/workspace_members.go:562)
 * behind the same ScopeAdmin floor createDelegation already requires. The caveat
 * had become a claim that a capability was missing when only the client was.
 *
 * Escalation writes are authorization-adjacent, so they never enter the offline
 * queue: a policy change replayed hours later is a governance hazard.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { DelegatePicker } from "@/components/settings/DelegatePicker";

import {
  ESCALATION_HOUR_CHOICES,
  getEscalationPolicy,
  isDelegationActive,
  listApprovalDelegations,
  normalizeEscalationPolicy,
  putEscalationPolicy,
  revokeApprovalDelegation,
  sortDelegations,
  type ApprovalDelegation,
} from "@/api/approvalGovernance";
import { Chip } from "@/components/Chip";
import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  Card,
  FieldLabel,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { relativeTime, truncateMiddle } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { transitionLabel } from "@/lib/direction";

export function ApprovalGovernanceSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [hours, setHours] = useState<number | null>(null);
  const [notifyOwners, setNotifyOwners] = useState(false);

  const policy = useQuery({
    queryKey: ["approval-escalation-policy", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async () => {
      const res = await getEscalationPolicy();
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return normalizeEscalationPolicy(res.data);
    },
    staleTime: 60_000,
  });

  const delegations = useQuery({
    queryKey: ["approval-delegations", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<ApprovalDelegation[]> => {
      const res = await listApprovalDelegations();
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return sortDelegations(res.data?.delegations ?? []);
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!policy.data) return;
    setHours(policy.data.escalateAfterHours ?? null);
    setNotifyOwners(policy.data.notifyOwners);
  }, [policy.data]);

  const savePolicy = (next: { hours: number | null; notify: boolean }) => {
    const previous = { hours, notify: notifyOwners };
    setHours(next.hours);
    setNotifyOwners(next.notify);
    haptics.tap();
    void putEscalationPolicy({
      escalateAfterHours: next.hours,
      notifyOwners: next.notify,
    }).then((res) => {
      if (res.error) {
        setHours(previous.hours);
        setNotifyOwners(previous.notify);
        toast({ kind: "error", message: "Couldn't save the escalation policy." });
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ["approval-escalation-policy", gate.tenantId],
      });
    });
  };

  const revoke = async (row: ApprovalDelegation) => {
    // Irreversible: a revoked delegation cannot be restored, only recreated —
    // and recreating it is not possible from mobile. That earns a confirm
    // rather than a toast-with-undo.
    const ok = await confirm({
      title: "Revoke this delegation?",
      message:
        "Approvals will stop routing to the covering user immediately. It cannot be restored from the mobile app.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    const res = await revokeApprovalDelegation(row.id);
    if (res.error) {
      toast({ kind: "error", message: "Couldn't revoke that delegation." });
      return;
    }
    haptics.success();
    toast({ kind: "success", message: "Delegation revoked." });
    void queryClient.invalidateQueries({
      queryKey: ["approval-delegations", gate.tenantId],
    });
  };

  return (
    <Card>
      <FieldLabel marginBottom={6}>Escalate after</FieldLabel>
      {policy.isLoading ? (
        <SkeletonList rows={1} lines={2} label="Loading escalation policy" />
      ) : policy.isError ? (
        <ErrorState
          compact
          error={policy.error}
          onRetry={() => void policy.refetch()}
        />
      ) : (
        <>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            <Chip
              label="Off"
              active={hours === null}
              accessibilityLabel="Escalation off"
              onPress={() => savePolicy({ hours: null, notify: notifyOwners })}
            />
            {ESCALATION_HOUR_CHOICES.map((choice) => (
              <Chip
                key={choice}
                label={`${choice}h`}
                active={hours === choice}
                accessibilityLabel={`Escalate after ${choice} hours`}
                onPress={() =>
                  savePolicy({ hours: choice, notify: notifyOwners })
                }
              />
            ))}
          </View>
          <View style={{ marginTop: 12 }}>
            <SettingsSwitchRow
              label="Notify workspace owners on escalation"
              hint="Owners are paged when a request passes the threshold above."
              value={notifyOwners}
              onValueChange={(next) => savePolicy({ hours, notify: next })}
              disabled={hours === null}
            />
          </View>
        </>
      )}

      <View
        style={{
          marginTop: 16,
          borderTopWidth: 1,
          borderTopColor: t.borderSubtle,
          paddingTop: 12,
        }}
      >
        <FieldLabel marginBottom={8}>Delegations</FieldLabel>
        <DelegationList
          rows={Array.isArray(delegations.data) ? delegations.data : []}
          isLoading={delegations.isLoading}
          isError={delegations.isError}
          error={delegations.error}
          onRetry={() => void delegations.refetch()}
          onRevoke={(row) => void revoke(row)}
        />
        <DelegatePicker />
      </View>
    </Card>
  );
}

function DelegationList({
  rows,
  isLoading,
  isError,
  error,
  onRetry,
  onRevoke,
}: {
  rows: ApprovalDelegation[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  onRevoke: (row: ApprovalDelegation) => void;
}) {
  const { t } = useTheme();
  if (isError) return <ErrorState compact error={error} onRetry={onRetry} />;
  if (isLoading && rows.length === 0) {
    return <SkeletonList rows={2} lines={2} label="Loading delegations" />;
  }
  if (rows.length === 0) {
    return (
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        No approval delegations. Requests route to their usual approvers.
      </Text>
    );
  }
  return (
    <View style={{ gap: 12 }}>
      {rows.slice(0, 6).map((row) => {
        const active = isDelegationActive(row);
        return (
          <View
            key={row.id}
            style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
          >
            <View style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                }}
              >
                {transitionLabel(
                  truncateMiddle(row.fromUserId, 12),
                  truncateMiddle(row.toUserId, 12),
                )}
              </Text>
              <Text
                numberOfLines={1}
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  marginTop: 2,
                  fontFamily: FONT.regular,
                }}
              >
                {row.endsAt
                  ? `Ends ${relativeTime(row.endsAt)}`
                  : "No end date"}
                {row.reason ? ` · ${row.reason}` : ""}
              </Text>
            </View>
            {/* Text, not just colour: an "Active" state signalled only by a
                green pill is invisible to colour-blind users. */}
            <Pill
              label={active ? "Active" : "Ended"}
              tone={active ? "success" : "neutral"}
            />
            {active ? (
              <Pressable
                onPress={() => onRevoke(row)}
                accessibilityRole="button"
                accessibilityLabel={`Revoke delegation to ${row.toUserId}`}
                hitSlop={8}
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 4,
                }}
              >
                <Text
                  // Trailing row action beside a status pill: dense.
                  {...typeCap("control")}
                  style={{
                    color: t.danger,
                    ...typeStyle("control"),
                    fontFamily: FONT.medium,
                  }}
                >
                  Revoke
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
