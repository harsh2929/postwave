/**
 * SmsPolicyPanel — stored quiet-hours and keyword definitions, mounted above
 * the opt-out list without implying that release-held dispatch is live.
 *
 * Desktop pairs all three on one page (apps/desktop/src/pages/SmsSuppressions.tsx):
 * the opt-out roster, the quiet-hours windows and the stored keyword rules are
 * one operator concern. Tenant-global quiet rules are enforced by the internal
 * eligibility gate and enabled opt-out rules authorize inbound state changes.
 * Hosted callback ingestion, provider dispatch, automatic replies, scheduling,
 * and delivery remain release-held; country labels are not jurisdiction proof.
 *
 * It is COLLAPSED by default with the verdict visible in the header, so the
 * screen still opens on the opt-out list it is named for while the answer to
 * the held-messages question is one line above it. It owns its own queries —
 * the `HubDiagnostics` pattern this codebase already uses — so a dead policy
 * read can never blank the list beneath it, and the screen does not grow two
 * more hooks. Its body also hosts sender pause/resume (SmsSendersSection —
 * ScopeAdmin, not release-held), whose read runs only while the panel is open.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeywordResponsesCard } from "@/components/sms/KeywordResponsesCard";
import { QuietHoursCard } from "@/components/sms/QuietHoursCard";
import { SmsSendersSection } from "@/components/sms/SmsSendersSection";
import { useToast } from "@/components/Toast";
import {
  useSetKeywordResponseEnabled,
  useSetQuietHoursEnabled,
  useSmsKeywordResponses,
  useSmsQuietHours,
} from "@/hooks/useSmsPolicies";
import { useSmsInboxAccess } from "@/hooks/useSmsInbox";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  quietHoursSummary,
  type SmsKeywordResponse,
  type SmsQuietHoursRule,
} from "@/lib/smsPolicies";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * A failed policy read must say so — never render as "no windows configured",
 * which is the reassuring answer and the wrong one.
 */
function policyNotice(
  what: string,
  failed: boolean,
  offline: boolean,
): string | null {
  if (!failed) return null;
  return offline
    ? `${what} can't be read offline — it is current private stored policy, so no copy is kept.`
    : `${what} couldn't be loaded, so this is not a statement that none exist.`;
}

function policyWriteFailureMessage(error: unknown, fallback: string): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "offline_write_refused" && error instanceof Error) {
    return error.message;
  }
  if (
    (code === "sms_policy_outcome_unknown" ||
      code === "sms_policy_receipt_confirmed_identity_changed") &&
    error instanceof Error
  ) {
    return error.message;
  }
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 403)
    return "Your admin access changed. Refresh and try again.";
  if (status === 409)
    return "That stored policy changed. Reload and try again.";
  if (code === "country_scope_release_held")
    return "That historical country scope is unsupported. Disable the rule to retire the scope before enabling it again.";
  if (status === 429) return "Too many changes. Wait a minute and try again.";
  return fallback;
}

function policyMutationReady(
  canWrite: boolean,
  roleAllowed: boolean,
  canRequest: boolean,
  offline: boolean,
  succeeded: boolean,
  failed: boolean,
  fetching: boolean,
): boolean {
  return (
    canWrite &&
    roleAllowed &&
    canRequest &&
    !offline &&
    succeeded &&
    !failed &&
    !fetching
  );
}

export interface SmsPolicyPanelProps {
  /** Parent route owner/admin verdict; every policy route is exact-admin. */
  canWrite: boolean;
}

export function SmsPolicyPanel({ canWrite }: SmsPolicyPanelProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  const now = useNowTicker();
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [policyWriteBusy, setPolicyWriteBusy] = useState(false);
  const policyWriteBusyRef = useRef(false);

  const smsAccess = useSmsInboxAccess();
  const quiet = useSmsQuietHours(smsAccess);
  const keywords = useSmsKeywordResponses(smsAccess);
  const setQuiet = useSetQuietHoursEnabled(smsAccess);
  const setKeyword = useSetKeywordResponseEnabled(smsAccess);

  const offline = !gate.enabled || !smsAccess.online;
  const rules = useMemo(
    () => (Array.isArray(quiet.data) ? quiet.data : []),
    [quiet.data],
  );
  const summary = useMemo(() => quietHoursSummary(rules, now), [rules, now]);
  const accessNotice = smsAccess.roleAllowed
    ? null
    : (smsAccess.denialReason ??
      "Stored SMS policies are restricted to workspace owners and admins.");
  const quietNotice =
    accessNotice ??
    policyNotice("Quiet hours", quiet.isError || offline, offline);
  const keywordNotice =
    accessNotice ??
    policyNotice("Keyword rules", keywords.isError || offline, offline);
  const quietMutationReady = policyMutationReady(
    canWrite,
    smsAccess.roleAllowed,
    smsAccess.canRequest,
    offline,
    quiet.isSuccess,
    quiet.isError,
    quiet.isFetching,
  );
  const keywordMutationReady = policyMutationReady(
    canWrite,
    smsAccess.roleAllowed,
    smsAccess.canRequest,
    offline,
    keywords.isSuccess,
    keywords.isError,
    keywords.isFetching,
  );

  const toggleQuiet = useCallback(
    async (rule: SmsQuietHoursRule, enabled: boolean) => {
      if (!quietMutationReady) {
        toast({
          kind: "error",
          message:
            "Reload the current private quiet-hours rules before changing one. Stale policy is orientation only.",
        });
        return;
      }
      if (policyWriteBusyRef.current) return;
      if (enabled && rule.countryCode !== "") {
        toast({
          kind: "warning",
          message:
            "This historical country-scoped rule cannot be enabled. NANP identity does not prove recipient country; disable an enabled scoped rule first to retire that metadata.",
        });
        return;
      }
      policyWriteBusyRef.current = true;
      setPolicyWriteBusy(true);
      try {
        if (!enabled) {
          const retiresHistoricalCountry = rule.countryCode !== "";
          const approved = await confirm({
            title: "Switch off this quiet-hours rule?",
            message: retiresHistoricalCountry
              ? `${rule.label.trim() || "This stored window"} will be switched off and its unsupported historical ${rule.countryCode} scope will be retired atomically. NANP identity does not prove recipient country.`
              : `${rule.label.trim() || "This stored window"} will no longer be evaluated as an enabled policy rule. This changes future policy eligibility only; it proves no live send or delivery.`,
            confirmLabel: "Switch rule off",
            destructive: true,
            consequence:
              "Your exact owner/admin tenant identity is revalidated before the stored rule changes.",
          });
          if (!approved) return;
        }
        haptics.tap();
        setPendingId(rule.id);
        await setQuiet.mutateAsync({ rule, enabled });
        haptics.success();
        const name = rule.label.trim() || "That window";
        const retiredHistoricalCountry = !enabled && rule.countryCode !== "";
        toast({
          kind: enabled ? "info" : "warning",
          message: enabled
            ? `${name} is on as a stored rule. It would hold an otherwise eligible text; SMS dispatch remains release-held.`
            : retiredHistoricalCountry
              ? `${name} is off and its unsupported historical ${rule.countryCode} scope was retired. It may now be re-enabled as a tenant-global gate rule; downstream SMS dispatch remains release-held.`
              : `${name} is off as a stored rule. This makes no live-delivery claim; SMS dispatch remains release-held.`,
        });
      } catch (error: unknown) {
        haptics.error();
        toast({
          kind: "error",
          message: policyWriteFailureMessage(
            error,
            "Couldn't change that quiet-hours window.",
          ),
        });
      } finally {
        setPendingId(null);
        policyWriteBusyRef.current = false;
        setPolicyWriteBusy(false);
      }
    },
    [confirm, quietMutationReady, setQuiet, toast],
  );

  const toggleKeyword = useCallback(
    async (row: SmsKeywordResponse, enabled: boolean) => {
      if (!keywordMutationReady) {
        toast({
          kind: "error",
          message:
            "Reload the current private keyword rules before changing one. Stale policy is orientation only.",
        });
        return;
      }
      if (policyWriteBusyRef.current) return;
      policyWriteBusyRef.current = true;
      setPolicyWriteBusy(true);
      try {
        if (!enabled) {
          const approved = await confirm({
            title: "Disable this opt-out match rule?",
            message: `${row.keyword} will no longer be an enabled custom opt-out definition. Provider-authoritative STOP handling is unchanged; no live callback or consent-state outcome is inferred.`,
            confirmLabel: "Disable stored rule",
            destructive: true,
            consequence:
              "Your exact owner/admin tenant identity is revalidated before the stored rule changes.",
          });
          if (!approved) return;
        }
        haptics.tap();
        setPendingId(row.id);
        await setKeyword.mutateAsync({ row, enabled });
        haptics.success();
        toast({
          kind: enabled ? "success" : "info",
          message: enabled
            ? `${row.keyword} stored opt-out match rule is enabled. Verified provider callback ingestion and automatic confirmation dispatch remain release-held.`
            : `${row.keyword} stored opt-out match rule is disabled. Verified provider callback ingestion and automatic confirmation dispatch remain release-held.`,
        });
      } catch (error: unknown) {
        haptics.error();
        toast({
          kind: "error",
          message: policyWriteFailureMessage(
            error,
            "Couldn't change that keyword.",
          ),
        });
      } finally {
        setPendingId(null);
        policyWriteBusyRef.current = false;
        setPolicyWriteBusy(false);
      }
    },
    [confirm, keywordMutationReady, setKeyword, toast],
  );

  // The header carries the stored-rule verdict, never a provider-send claim.
  const headline = quietNotice ?? summary.sentence;

  return (
    <View style={{ marginBottom: 10 }}>
      <Pressable
        onPress={() => {
          haptics.tap();
          setOpen((prev) => !prev);
        }}
        accessibilityRole="button"
        accessibilityLabel={`SMS sending policy. ${headline}`}
        accessibilityHint={
          open
            ? "Collapses quiet hours, sender pause switches and stored keyword rules"
            : "Shows quiet-hours windows, sender pause switches and stored keyword rules"
        }
        accessibilityState={{ expanded: open }}
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          minHeight: 44,
          gap: 4,
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
            {...typeCap("caption")}
            importantForAccessibility="no"
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.bold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
            }}
          >
            Sending policy
          </Text>
          <Text
            {...typeCap("control")}
            importantForAccessibility="no"
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {open ? "Hide" : "Show"}
          </Text>
        </View>
        <Text
          {...typeCap("bodySmall")}
          importantForAccessibility="no"
          style={{
            color: quietNotice ? t.fgMuted : t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {headline}
        </Text>
      </Pressable>

      {open ? (
        <View style={{ marginTop: 10 }}>
          <QuietHoursCard
            rules={rules}
            summary={summary}
            unavailableReason={quietNotice}
            loading={quiet.isLoading && !quietNotice}
            canEdit={quietMutationReady && !policyWriteBusy}
            pendingId={pendingId}
            onToggle={toggleQuiet}
            now={now}
          />
          <SmsSendersSection access={smsAccess} />
          <KeywordResponsesCard
            rows={Array.isArray(keywords.data) ? keywords.data : []}
            unavailableReason={keywordNotice}
            loading={keywords.isLoading && !keywordNotice}
            canEdit={keywordMutationReady && !policyWriteBusy}
            pendingId={pendingId}
            onToggle={toggleKeyword}
          />
        </View>
      ) : null}
    </View>
  );
}
