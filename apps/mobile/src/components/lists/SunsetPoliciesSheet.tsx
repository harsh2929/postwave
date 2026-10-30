/**
 * SunsetPoliciesSheet — the sunset (list-hygiene) surface on the phone
 * (desktop anchor: components/subscribers/SunsetPoliciesCard.tsx).
 *
 * What travels: policy definitions (view, create, edit) and per-policy
 * execution history. What deliberately does NOT: running a policy. The
 * desktop anchor withholds execution as "draft mode" because the legacy run
 * endpoint is a synchronous sweep with no reviewed plan, progress,
 * cancellation, or receipt — and a phone is the worst possible place to
 * out-ship that safety call. The draft-mode note renders above the rows,
 * and every save goes up with `enabled: false` (lib/listHygiene.ts).
 *
 * ROLE: every policy read/write here is admin-scoped. The Lists screen
 * withholds the entry point below admin; this sheet keeps a defensive
 * caption for the deep-linked/stale-role case rather than 403-spamming.
 *
 * Writes are ONLINE-ONLY (never the offline outbox): a suppression policy
 * definition must not materialise from a queue at a moment nobody chose.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { useToast } from "@/components/Toast";
import { SunsetPolicyForm } from "@/components/lists/SunsetPolicyForm";
import {
  useSaveSunsetPolicy,
  useSunsetExecutions,
  useSunsetPolicies,
} from "@/hooks/useListHygiene";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import {
  SUNSET_ADMIN_CAPTION,
  SUNSET_DRAFT_MODE_NOTE,
  sunsetCriteriaLine,
  type SunsetPolicy,
  type SunsetPolicyDraft,
} from "@/lib/listHygiene";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function Caption({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 4,
      }}
    >
      {children}
    </Text>
  );
}

/** One policy row + its on-demand execution history. */
function PolicyRow({
  policy,
  historyOpen,
  onToggleHistory,
  onEdit,
}: {
  policy: SunsetPolicy;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onEdit: () => void;
}) {
  const { t } = useTheme();
  const executions = useSunsetExecutions(historyOpen ? policy.id : null);
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        paddingVertical: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {policy.name}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: policy.enabled ? t.success : t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
          }}
        >
          {policy.enabled ? "Active" : "Paused"}
        </Text>
      </View>
      <Caption>{sunsetCriteriaLine(policy)}</Caption>
      {policy.updatedAt ? (
        <Caption>{`Updated ${relativeTime(policy.updatedAt)}`}</Caption>
      ) : null}
      <View style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${policy.name}`}
          style={{ paddingVertical: 4 }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontFamily: FONT.medium,
            }}
          >
            Edit
          </Text>
        </Pressable>
        <Pressable
          onPress={onToggleHistory}
          accessibilityRole="button"
          accessibilityLabel={`Run history for ${policy.name}`}
          accessibilityState={{ expanded: historyOpen }}
          style={{ paddingVertical: 4 }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontFamily: FONT.medium,
            }}
          >
            {historyOpen ? "Hide history" : "History"}
          </Text>
        </Pressable>
      </View>
      {historyOpen ? (
        executions.isError ? (
          <ErrorState
            compact
            error={executions.error}
            onRetry={() => void executions.refetch()}
          />
        ) : executions.isLoading ? (
          <Caption>Loading history…</Caption>
        ) : (executions.data?.length ?? 0) === 0 ? (
          <Caption>No executions recorded for this policy.</Caption>
        ) : (
          executions.data?.map((row) => (
            <View key={row.id} style={{ marginTop: 6 }}>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fg,
                  ...typeStyle("caption"),
                  fontFamily: FONT.medium,
                }}
              >
                {`${row.actionTaken}${row.reason ? ` · ${row.reason}` : ""}`}
              </Text>
              <Caption>{relativeTime(row.executedAt)}</Caption>
            </View>
          ))
        )
      ) : null}
    </View>
  );
}

export function SunsetPoliciesSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const isAdmin = canAccessMinimumRole("admin", gate.effectiveRole);
  const policies = useSunsetPolicies(visible && isAdmin);
  const save = useSaveSunsetPolicy();
  // null = closed; {id:null} = creating; {id, policy} = editing.
  const [form, setForm] = useState<{
    id: string | null;
    policy: SunsetPolicy | null;
  } | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const close = () => {
    setForm(null);
    setHistoryFor(null);
    onClose();
  };

  const submit = (draft: SunsetPolicyDraft) => {
    if (save.isPending || !form) return;
    save.mutate(
      { id: form.id, draft },
      {
        onSuccess: () => {
          setForm(null);
          toast({
            kind: "success",
            message: `Saved “${draft.name.trim()}” — it stays paused.`,
          });
        },
        onError: (error) => {
          toast({
            kind: "error",
            message:
              errorPresentation(error).message || "Couldn't save the policy.",
          });
        },
      },
    );
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Sunset policies"
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{ color: t.fg, ...typeStyle("title"), fontFamily: FONT.bold }}
      >
        Sunset policies
      </Text>

      {!isAdmin ? (
        // Defensive: the Lists screen withholds the entry point below admin,
        // but a stale role between screens must read as the rule, not a 403.
        <Caption>{SUNSET_ADMIN_CAPTION}</Caption>
      ) : (
        <>
          <Caption>{SUNSET_DRAFT_MODE_NOTE}</Caption>

          {policies.isError ? (
            <ErrorState
              error={policies.error}
              onRetry={() => void policies.refetch()}
            />
          ) : policies.isLoading ? (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <ActivityIndicator color={t.fgMuted} />
            </View>
          ) : (policies.data?.length ?? 0) === 0 ? (
            <Caption>No sunset policies yet.</Caption>
          ) : (
            <View style={{ marginTop: 10 }}>
              {policies.data?.map((policy) => (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  historyOpen={historyFor === policy.id}
                  onToggleHistory={() =>
                    setHistoryFor((cur) => (cur === policy.id ? null : policy.id))
                  }
                  onEdit={() => setForm({ id: policy.id, policy })}
                />
              ))}
            </View>
          )}

          {form ? (
            <SunsetPolicyForm
              key={form.id ?? "new"}
              initial={form.policy}
              submitting={save.isPending}
              onCancel={() => setForm(null)}
              onSubmit={submit}
            />
          ) : (
            <Pressable
              onPress={() => setForm({ id: null, policy: null })}
              accessibilityRole="button"
              accessibilityLabel="New sunset policy"
              style={{
                marginTop: 14,
                borderColor: t.border,
                borderWidth: 1,
                borderRadius: 10,
                paddingVertical: 11,
                alignItems: "center",
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.medium,
                }}
              >
                New policy
              </Text>
            </Pressable>
          )}
        </>
      )}
    </KeyboardFormSheet>
  );
}
