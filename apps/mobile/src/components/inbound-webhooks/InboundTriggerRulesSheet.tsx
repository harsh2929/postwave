/**
 * InboundTriggerRulesSheet — the rules that act on events reaching ONE
 * endpoint: list them, pause or resume one, edit one, delete one, add one.
 *
 * WHY THIS EXISTS. The inbound-webhooks screen could show events arriving and
 * could turn a whole endpoint off, but the thing that usually misbehaves is a
 * single rule — the one enrolling every "test" event into onboarding — and
 * the phone could neither see it nor pause it. Turning the endpoint off to
 * stop one rule refuses every upstream sender with 410 Gone; pausing the rule
 * stops exactly the thing that is wrong. Desktop anchor: components/webhooks/
 * TriggersPanel.tsx + TriggerEditorDialog.tsx.
 *
 * ONE SHEET, THE FORM INLINE. The sheet is a KeyboardFormSheet (a scrolling
 * page-sheet that already avoids the keyboard) and the create/edit form
 * renders inside it in place of the "Add rule" button, as SunsetPoliciesSheet
 * does — never a modal presented from a modal. The list is a plain map: an
 * endpoint holds a handful of rules, not hundreds.
 *
 * ROLE. All four trigger routes are admin (routeauth manifest); the screen
 * that mounts this is itself admin-only, so the non-admin branch here is the
 * stale-role-between-screens case and reads as the rule, not as a 403.
 *
 * DELETE is the one irreversible verb and goes through the ConfirmSheet with
 * the desktop's own consequence copy; pause is offered there as the
 * reversible alternative. Toggle and save are not confirmed — both are
 * reversible in one tap.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { useToast } from "@/components/Toast";
import { InboundTriggerRuleForm } from "@/components/inbound-webhooks/InboundTriggerRuleForm";
import { InboundTriggerRuleRow } from "@/components/inbound-webhooks/InboundTriggerRuleRow";
import {
  useInboundTriggerRuleActions,
  useInboundWebhookTriggers,
} from "@/hooks/useInboundWebhookTriggers";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  TRIGGER_RULES_ADMIN_CAPTION,
  triggerDeleteConfirmCopy,
  triggerRulesSummary,
  type InboundTriggerRule,
  type TriggerRuleInput,
} from "@/lib/inboundTriggerRules";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface InboundTriggerRulesSheetProps {
  /** The open endpoint, or null when the sheet is closed. */
  endpoint: { id: string; name: string; slug: string } | null;
  onClose: () => void;
}

export function InboundTriggerRulesSheet({
  endpoint,
  onClose,
}: InboundTriggerRulesSheetProps) {
  const { t } = useTheme();
  return (
    <KeyboardFormSheet
      visible={endpoint !== null}
      onClose={onClose}
      accessibilityLabel="Trigger rules"
      contentContainerStyle={{ paddingTop: 12 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flexShrink: 1 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={2}
            {...typeCap("title")}
            style={{ color: t.fg, ...typeStyle("title"), fontFamily: FONT.display }}
          >
            {endpoint?.name || endpoint?.slug || "Trigger rules"}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 2,
            }}
          >
            Trigger rules · route verified events only when a payload condition matches.
          </Text>
        </View>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close trigger rules"
          hitSlop={12}
          style={{ minHeight: 44, minWidth: 44, alignItems: "flex-end", justifyContent: "center" }}
        >
          <Text
            {...typeCap("callout")}
            style={{ color: t.accent, ...typeStyle("callout"), fontFamily: FONT.semibold }}
          >
            Close
          </Text>
        </Pressable>
      </View>
      {/* Keyed on the endpoint so every open starts with no half-typed form
          or stale pending id from the last one. */}
      {endpoint ? <RulesBody key={endpoint.id} endpoint={endpoint} /> : null}
    </KeyboardFormSheet>
  );
}

function Caption({ children, tone = "muted" }: { children: string; tone?: "muted" | "subtle" }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: tone === "subtle" ? t.fgSubtle : t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 6,
      }}
    >
      {children}
    </Text>
  );
}

function RulesBody({ endpoint }: { endpoint: { id: string; name: string; slug: string } }) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const isAdmin = canAccessMinimumRole("admin", gate.effectiveRole);
  const query = useInboundWebhookTriggers(endpoint.id, isAdmin);
  const actions = useInboundTriggerRuleActions();
  // null = closed; {id: null} = creating; {id, rule} = editing.
  const [form, setForm] = useState<{ id: string | null; rule: InboundTriggerRule | null } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const rules: InboundTriggerRule[] = Array.isArray(query.data) ? query.data : [];
  const hasRows = rules.length > 0;
  const busy =
    actions.save.isPending || actions.setActive.isPending || actions.remove.isPending;

  const fail = (err: unknown, fallback: string) => {
    haptics.error();
    toast({ kind: "error", message: errorPresentation(err).message || fallback });
  };

  const onToggle = useCallback(
    async (rule: InboundTriggerRule) => {
      setPendingId(rule.id);
      try {
        await actions.setActive.mutateAsync({
          endpointId: endpoint.id,
          triggerId: rule.id,
          active: !rule.active,
        });
        haptics.success();
        toast({ kind: "success", message: rule.active ? "Rule paused." : "Rule resumed." });
      } catch (err) {
        fail(err, rule.active ? "Couldn't pause the rule." : "Couldn't resume the rule.");
      } finally {
        setPendingId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fail` is a stable closure over toast.
    [actions.setActive, endpoint.id, toast],
  );

  const onDelete = useCallback(
    async (rule: InboundTriggerRule) => {
      const copy = triggerDeleteConfirmCopy(rule);
      const ok = await confirm({ ...copy, destructive: true });
      if (!ok) return;
      setPendingId(rule.id);
      try {
        await actions.remove.mutateAsync({ endpointId: endpoint.id, triggerId: rule.id });
        haptics.success();
        toast({ kind: "success", message: "Rule deleted." });
      } catch (err) {
        fail(err, "Couldn't delete the rule.");
      } finally {
        setPendingId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fail` is a stable closure over toast.
    [actions.remove, confirm, endpoint.id, toast],
  );

  const onSubmit = (input: TriggerRuleInput) => {
    if (!form || actions.save.isPending) return;
    const editing = form.id !== null;
    actions.save.mutate(
      { endpointId: endpoint.id, triggerId: form.id, input },
      {
        onSuccess: () => {
          setForm(null);
          haptics.success();
          toast({ kind: "success", message: editing ? "Rule updated." : "Rule created." });
        },
        onError: (err) => fail(err, editing ? "Couldn't save the rule." : "Couldn't create the rule."),
      },
    );
  };

  if (!isAdmin) {
    // The screen withholds its own entry below admin; this is the stale-role
    // case and must read as the rule, never as a manufactured empty list.
    return <Caption>{TRIGGER_RULES_ADMIN_CAPTION}</Caption>;
  }

  return (
    <>
      <Text
        {...typeCap("label")}
        style={{ color: t.fgMuted, ...typeStyle("label"), fontFamily: FONT.regular, marginTop: 12 }}
      >
        {query.isLoading || (query.isError && !hasRows) ? " " : triggerRulesSummary(rules)}
      </Text>

      {query.isError && hasRows ? (
        <View style={{ marginTop: 8 }}>
          <StaleDataBanner onRetry={() => void query.refetch()} />
        </View>
      ) : null}

      {query.isError && !hasRows ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !gate.enabled && !hasRows ? (
        <Caption>
          {"You're offline, so this endpoint's rules can't be loaded. Reconnect and open it again."}
        </Caption>
      ) : query.isLoading ? (
        <View style={{ paddingVertical: 24, alignItems: "center" }}>
          <ActivityIndicator color={t.fgMuted} />
          <Caption>Loading trigger rules…</Caption>
        </View>
      ) : !hasRows ? (
        <View style={{ marginTop: 10 }}>
          <Text
            {...typeCap("bodySmall")}
            style={{ color: t.fg, ...typeStyle("bodySmall"), fontFamily: FONT.semibold }}
          >
            No routing rules yet
          </Text>
          <Caption>
            Add one after a representative event arrives, so you can check its JSON paths against a real payload in the events feed.
          </Caption>
        </View>
      ) : (
        <View style={{ marginTop: 8 }}>
          {rules.map((rule) => (
            <InboundTriggerRuleRow
              key={rule.id}
              rule={rule}
              pending={pendingId === rule.id}
              busy={busy || form !== null}
              canWrite
              onToggle={(target) => void onToggle(target)}
              onEdit={(target) => setForm({ id: target.id, rule: target })}
              onDelete={(target) => void onDelete(target)}
            />
          ))}
        </View>
      )}

      {form ? (
        <InboundTriggerRuleForm
          key={form.id ?? "new"}
          initial={form.rule}
          submitting={actions.save.isPending}
          onCancel={() => setForm(null)}
          onSubmit={onSubmit}
        />
      ) : (
        <Pressable
          onPress={() => setForm({ id: null, rule: null })}
          disabled={busy || query.isLoading || !gate.enabled}
          accessibilityRole="button"
          accessibilityLabel="Add a trigger rule"
          accessibilityState={{ disabled: busy || query.isLoading || !gate.enabled }}
          style={{
            marginTop: 14,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingVertical: 11,
            alignItems: "center",
            opacity: busy || query.isLoading || !gate.enabled ? 0.5 : 1,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.medium }}
          >
            Add rule
          </Text>
        </Pressable>
      )}
      <Caption tone="subtle">
        Pausing a rule is reversible and keeps its fired count. Turning the whole endpoint off is on the screen behind this sheet.
      </Caption>
    </>
  );
}
