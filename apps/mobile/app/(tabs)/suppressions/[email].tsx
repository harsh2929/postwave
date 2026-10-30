/**
 * Suppression detail — the answer to "why didn't this person get my email?".
 *
 * The list row used to be a dead end: everything an operator needs — which
 * reason, who added it, whether it was previously removed and re-added, when
 * each event happened — lived behind two live endpoints mobile never called
 * (GET /api/v1/deliverability/suppressions/{email}/audit, and the filtered
 * list read that resolves the current row).
 *
 * The audit trail is keyed by EMAIL server-side, so it survives the row's
 * deletion. That is deliberate and useful here: after un-suppressing, this
 * screen still explains what happened and by whom.
 */
import { useCallback } from "react";
import { RefreshControl, ScrollView, Share, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { CachedNotice } from "@/components/deliverability/CachedNotice";
import { HeaderAction } from "@/components/deliverability/HeaderAction";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonDetail } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useNowTicker } from "@/hooks/useNowTicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useRemoveSuppression,
  useSuppressionAudit,
  useSuppressions,
} from "@/hooks/useSuppressionOps";
import { FONT } from "@/lib/fonts";
import { goBackOr } from "@/lib/nav";
import { dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { reasonLabel, reasonTone } from "@/lib/suppressionSearch";
import { useAuthStore } from "@/store/auth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function SuppressionDetail() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const now = useNowTicker();
  useScreenViewed("suppression-detail");

  const params = useLocalSearchParams<{ email?: string }>();
  const email = (params.email ?? "").trim();

  // The exact-match arm of the list read resolves the CURRENT row (reason,
  // status, created_at); the audit endpoint carries the history.
  const current = useSuppressions(email);
  const audit = useSuppressionAudit(email);
  const remove = useRemoveSuppression();
  const refresh = useManualRefresh([current.refetch, audit.refetch]);

  const mode = useAuthStore((s) => s.mode);
  const canWrite = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  // Three unguarded hops used to live on one line here. `data.value` arrives
  // from the SecureStore vault as readily as from the wire, and
  // `loadSnapshotBacked` hands a stored blob back with no shape check at all —
  // `isStored` proves only that `capturedAt` is a number — so a projection
  // written by an older build is a truthy non-array walking into `.find`.
  const items = current.data?.value?.items;
  const row = Array.isArray(items)
    ? items.find(
        (item) => (item.email ?? "").toLowerCase() === email.toLowerCase(),
      )
    : undefined;
  const auditItems = audit.data?.items;
  const entries = Array.isArray(auditItems) ? auditItems : [];

  const onUnsuppress = useCallback(async () => {
    // Irreversible from THIS screen's point of view — after removal the row is
    // gone and the operator has navigated away — so it earns a confirm rather
    // than an undo toast.
    const ok = await confirm({
      title: "Un-suppress this address?",
      message: `Moosewave will start sending to ${email} again.`,
      confirmLabel: "Un-suppress",
      destructive: true,
      consequence:
        "If the address hard-bounced, sending to it again can hurt your sender reputation.",
    });
    if (!ok) return;
    remove
      .mutateAsync(email)
      .then(() => {
        haptics.success();
        toast({ kind: "success", message: `${email} un-suppressed` });
        router.back();
      })
      .catch((e: unknown) => {
        haptics.error();
        toast({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      });
  }, [confirm, email, remove, toast]);

  // THREE ANSWERS, NOT TWO. "Not currently suppressed" is a claim about a
  // specific person's mailbox, and `Boolean(row)` produced it identically from
  // a read that succeeded with no match and from one that 500ed or had not
  // answered yet — a fact about the network rendered as a fact about the
  // customer, under a success-toned pill. An operator repeats it and the mail
  // is still being dropped. A verdict this screen has not received is never
  // rendered as one it has.
  const statusKnown = Boolean(current.isSuccess) && Array.isArray(items);
  const suppressed = Boolean(row);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={email || "Suppression"}
        subtitle={
          statusKnown
            ? suppressed
              ? "Suppressed"
              : "Not currently suppressed"
            : "Status unavailable"
        }
        // Entered cold from a search hit or deep link there is no history,
        // and a bare router.back() is a silent no-op that strands the user.
        onBack={() => goBackOr("/(tabs)/suppressions")}
        right={
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <HeaderAction
              label={"\u2934\uFE0E"}
              accessibilityLabel={`Share ${email}`}
              tone="muted"
              onPress={() => {
                haptics.tap();
                void Share.share({ message: email }).catch(() =>
                  toast({ kind: "error", message: "Couldn't open the share sheet." }),
                );
              }}
            />
            {canWrite && suppressed ? (
              <HeaderAction
                label="Un-suppress"
                accessibilityLabel={`Un-suppress ${email}`}
                disabled={remove.isPending}
                onPress={() => void onUnsuppress()}
              />
            ) : null}
          </View>
        }
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        <CachedNotice backing={current.data} now={now} />

        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 14,
            padding: 14,
            gap: 10,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <Pill
              label={
                row
                  ? reasonLabel(row.reason)
                  : statusKnown
                    ? "Not suppressed"
                    : "Status unavailable"
              }
              tone={
                row ? reasonTone(row.reason) : statusKnown ? "success" : "warning"
              }
            />
            {row?.status && row.status !== row.reason ? (
              <Pill label={row.status} tone="neutral" />
            ) : null}
          </View>
          {/* These four nodes carried the app-wide `MAX_TEXT_SCALE` number
              directly. They are on the ROLE scale now: same intent, but the
              size and the ceiling are one decision instead of two, and a
              card headline no longer shares a ceiling with a timestamp. */}
          <Text
            selectable
            {...typeCap("callout")}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontFamily: FONT.regular,
            }}
          >
            {email}
          </Text>
          {statusKnown ? null : (
            <Text
              accessibilityRole="alert"
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {"Moosewave couldn't read this address's suppression status, so it can't say whether mail is being dropped. Pull down to retry."}
            </Text>
          )}
          {row?.created_at ? (
            <Text
              {...typeCap("label")}
              accessibilityLabel={`Suppressed on ${dateTime(row.created_at)}`}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
                fontVariant: ["tabular-nums"],
              }}
            >
              {`Suppressed ${relativeTime(row.created_at, { now })}`}
            </Text>
          ) : null}
        </View>

        <SectionLabel>History</SectionLabel>
        <QueryStates
          query={audit}
          gate={gate}
          isEmpty={entries.length === 0}
          skeleton={<SkeletonDetail sections={2} />}
          offlineMessage="You're offline, so this address's history can't be loaded. Reconnect to see it."
          empty={{
            title: "No recorded history",
            description:
              "Audit entries are written when an address is added or removed. Older suppressions predate the audit trail.",
          }}
        >
          {entries.map((entry) => (
            <View
              key={entry.id}
              accessible
              accessibilityLabel={`${entry.action}${entry.reason ? `, ${reasonLabel(entry.reason)}` : ""}, by ${entry.actor}${entry.createdAt ? `, ${dateTime(entry.createdAt)}` : ""}`}
              style={{
                backgroundColor: t.surface,
                borderColor: t.borderSubtle,
                borderWidth: 1,
                borderRadius: 12,
                padding: 12,
                marginBottom: 8,
                gap: 6,
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
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  {entry.action === "add"
                    ? "Suppressed"
                    : entry.action === "remove"
                      ? "Un-suppressed"
                      : entry.action}
                </Text>
                {entry.createdAt ? (
                  <Text
                    {...typeCap("numeric")}
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("numeric"),
                      fontFamily: FONT.regular,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {relativeTime(entry.createdAt, { now })}
                  </Text>
                ) : null}
              </View>
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                {entry.reason ? `${reasonLabel(entry.reason)} · ` : ""}
                {entry.actor}
              </Text>
            </View>
          ))}
        </QueryStates>
      </ScrollView>
    </SafeAreaView>
  );
}
