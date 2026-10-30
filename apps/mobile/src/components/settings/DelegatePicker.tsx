/**
 * DelegatePicker — hand your approvals to a colleague, from a phone.
 *
 * GATE#11. This section shipped read + revoke and told the user, on screen: "New
 * delegations are created on the web admin — picking a covering teammate needs the
 * workspace member directory, which the mobile API does not expose yet." True when
 * written; stale now. `GET /api/v1/workspace/members` is mounted
 * (handlers/workspace_members.go:562) behind ScopeAdmin — the same floor
 * `POST /api/v1/approvals/delegations` already requires — so the picker is
 * buildable and the caveat was telling users a capability was missing when only
 * the client was.
 *
 * Remembering to hand over approvals on the way to the airport is a phone act if
 * anything is.
 *
 * Every rule the server enforces is mirrored before the button enables — no self
 * delegation, no past end date — so Save is never offered for a body that can only
 * fail. See approvalDelegationDraft, which is node-tested.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import {
  createApprovalDelegation,
  listWorkspaceMembers,
} from "@/api/approvalGovernance";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  delegationCandidates,
  delegationDraftError,
  delegationDraftMessage,
  delegationRequestBody,
  parseWorkspaceMembers,
  type WorkspaceMember,
} from "@/lib/approvalDelegationDraft";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function DelegatePicker() {
  const { t } = useTheme();
  const { toast } = useToast();
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const [toUserId, setToUserId] = useState("");

  const members = useQuery({
    queryKey: ["workspace-members", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<WorkspaceMember[]> => {
      const res = await listWorkspaceMembers();
      if (res.error) throw new Error(res.error.message);
      return parseWorkspaceMembers(res.data);
    },
  });

  const create = useMutation({
    mutationFn: async (targetId: string) => {
      const draft = {
        fromUserId: gate.userId ?? "",
        toUserId: targetId,
        endsAt: "",
        reason: "",
      };
      const invalid = delegationDraftError(draft, new Date());
      if (invalid) throw new Error(delegationDraftMessage(invalid));
      const res = await createApprovalDelegation(
        delegationRequestBody(draft, new Date().toISOString()),
      );
      if (res.error) throw new Error(res.error.message);
    },
    onSuccess: () => {
      setToUserId("");
      void queryClient.invalidateQueries({ queryKey: ["approval-delegations"] });
      toast({ kind: "success", message: "Approvals delegated." });
    },
    onError: (err) =>
      toast({
        kind: "error",
        message:
          err instanceof Error && err.message
            ? err.message
            : "Couldn't create the delegation.",
      }),
  });

  const candidates = useMemo(
    () =>
      delegationCandidates(
        // Array.isArray, not `?? []`: a truthy non-array reaches the candidate
        // filter and throws.
        Array.isArray(members.data) ? members.data : [],
        gate.userId ?? "",
      ),
    [members.data, gate.userId],
  );

  if (members.isLoading) return null;
  if (candidates.length === 0) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 10,
          fontFamily: FONT.regular,
        }}
      >
        No other active member can take your approvals. Add a teammate on the web
        admin first.
      </Text>
    );
  }

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Hand your approvals to someone while you are away. It starts now and runs
        until you revoke it.
      </Text>
      {candidates.map((member) => {
        const selected = member.id === toUserId;
        return (
          <Pressable
            key={member.id}
            onPress={() => {
              haptics.tap();
              setToUserId(selected ? "" : member.id);
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: create.isPending }}
            accessibilityLabel={`Delegate approvals to ${member.name}`}
            disabled={create.isPending}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: selected ? t.accent : t.fg,
                ...typeStyle("body"),
                fontFamily: selected ? FONT.semibold : FONT.regular,
              }}
              numberOfLines={1}
            >
              {selected ? "● " : "○ "}
              {member.name}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        onPress={() => {
          haptics.tap();
          create.mutate(toUserId);
        }}
        disabled={!toUserId || create.isPending}
        accessibilityRole="button"
        accessibilityLabel="Delegate my approvals"
        accessibilityState={{ disabled: !toUserId || create.isPending }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: toUserId && !create.isPending ? t.accent : t.fgSubtle,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {create.isPending ? "Delegating…" : "Delegate my approvals"}
        </Text>
      </Pressable>
    </View>
  );
}
