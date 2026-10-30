/**
 * Diagnostics — the support surface (NATIVE#7).
 *
 * Desktop has had `copyDesktopDiagnostics` + a recovery screen for a while;
 * mobile hid every operational signal it already held. When a customer said
 * "notifications stopped", support had nothing to ask for: the build profile,
 * the release stamp, whether the OS still grants notification permission, which
 * push token the server should be holding, whether a revocation is stuck in the
 * journal, whether the realtime stream is alive, and what is sitting unsent in
 * the offline queue — all of it lived in memory and none of it was reachable.
 *
 * This screen is deliberately READ-MOSTLY. The only writes are the two the
 * banner already offered (retry the pending revocation, discard a cancellable
 * queued change) plus "resume now", because a diagnostics screen that can break
 * things is a diagnostics screen support cannot safely ask a customer to open.
 *
 * The report text and its redaction rules live in src/lib/diagnosticsReport.ts
 * so they are unit-tested without a renderer, and so the copied text is
 * generated from THE SAME rows this screen renders.
 *
 * NativeWind v4 gotcha: every Pressable here uses a STATIC style object; the
 * `({ pressed }) => …` form silently drops layout.
 */
import * as Application from "expo-application";
import * as Device from "expo-device";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  I18nManager,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { Card } from "@/components/Card";
import { IdempotencyLedgerCard } from "@/components/diagnostics/IdempotencyLedgerCard";
import { Pill } from "@/components/Pill";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { BUILD_PROFILE } from "@/lib/config";
import {
  buildDiagnosticsReport,
  diagnosticsRows,
  type DiagnosticsSnapshot,
} from "@/lib/diagnosticsReport";
import { eventBusFreshness, useEventBusHealth } from "@/lib/eventBusStatus";
import { getNotificationPermissionGranted, retryPendingPushRevocation } from "@/lib/push";
import { readPendingPushRevocations } from "@/lib/pushRevocationJournal";
import { getOfflinePersistenceHealth } from "@/lib/offlinePersistenceHealth";
import { getPushToken, useAuthStore } from "@/store/auth";
import { OfflineQueueSection, useOfflineQueueModel } from "@/components/diagnostics/OfflineQueueSection";
import { OutboxDlqSection } from "@/components/diagnostics/OutboxDlqSection";
import { AppUpdateSection } from "@/components/diagnostics/AppUpdateSection";
import { TransfersSection } from "@/components/diagnostics/TransfersSection";
import { useTrackedShare } from "@/hooks/useTrackedShare";
import { deviceTextDirection, formatLocaleSummary } from "@/lib/localization";

/**
 * Per-route boundary. Diagnostics reads native + queue state that can be
 * shaped unexpectedly on a broken device — which is exactly when someone is
 * on this screen — so a throw here must not take the app down with it.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function DiagnosticsScreen() {
  useScreenViewed("diagnostics");
  const { t } = useTheme();
  const { toast } = useToast();
  const baseUrl = useAuthStore((s) => s.baseUrl);
  const tenantId = useAuthStore((s) => s.tenantId);
  const mode = useAuthStore((s) => s.mode);
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);

  const health = useEventBusHealth();
  const queue = useOfflineQueueModel();
  // The failure banner deep-links here with the conflicted write to resolve.
  const params = useLocalSearchParams<{ resolve?: string | string[] }>();
  const resolveOperationId =
    typeof params.resolve === "string" && params.resolve ? params.resolve : null;
  const trackedShare = useTrackedShare();
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [pushPermission, setPushPermission] = useState<boolean | null>(null);
  const [revocations, setRevocations] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [generatedAt, setGeneratedAt] = useState(() => Date.now());

  const readNativeState = useCallback(async () => {
    // Both reads touch the OS / SecureStore, so they are pulled on demand
    // rather than polled — a diagnostics screen must not itself be a battery
    // cost while a user leaves it open on a support call.
    const [granted, pending, token] = await Promise.all([
      getNotificationPermissionGranted().catch(() => null),
      readPendingPushRevocations().catch(() => []),
      getPushToken().catch(() => null),
    ]);
    setPushPermission(granted);
    setRevocations(pending.map((entry) => entry.baseUrl));
    setPushToken(token);
    setGeneratedAt(Date.now());
  }, []);

  useEffect(() => {
    void readNativeState();
  }, [readNativeState]);

  const snapshot = useMemo<DiagnosticsSnapshot>(() => {
    const persistence = getOfflinePersistenceHealth();
    return {
      generatedAt,
      buildProfile: BUILD_PROFILE,
      release: process.env.EXPO_PUBLIC_POSTWAVE_RELEASE ?? null,
      appVersion: Application.nativeApplicationVersion,
      platform: Platform.OS,
      osVersion: Device.osVersion,
      // "Why are my dates in the wrong order" is a locale question, and the
      // report could not answer it until lib/localization existed (NATIVE#43).
      formatLocale: formatLocaleSummary(),
      textDirection: deviceTextDirection(),
      apiOrigin: baseUrl,
      tenantId,
      authMode: mode ?? "signed out",
      role,
      pushPermission,
      pushToken,
      pendingRevocationOrigins: revocations,
      eventBus: {
        status: health.status,
        lastEventAt: health.lastEventAt,
        stalls: health.stalls,
        pauses: health.pauses,
        replayCursor: health.replayCursor,
      },
      offlineQueue: queue.counts,
      persistence: {
        evictions: persistence.droppedMutations,
        overflows: persistence.overflows,
        lastReason:
          persistence.limitBytes > 0
            ? `${persistence.lastBytes}/${persistence.limitBytes} bytes`
            : null,
      },
    };
  }, [
    generatedAt,
    baseUrl,
    tenantId,
    mode,
    role,
    pushPermission,
    pushToken,
    revocations,
    health,
    queue.counts,
  ]);

  const freshness = eventBusFreshness(health);
  const rows = diagnosticsRows(snapshot);

  // Was a hand-rolled `setRefreshing` pair. `useManualRefresh` is the shared
  // one, and it brings two things this copy lacked: it does not setState on an
  // unmounted tree when a slow SecureStore read resolves after the user has
  // left, and it confirms completion with a haptic like every other pull in
  // the app.
  const refresh = useManualRefresh([readNativeState, queue.refresh]);

  const onCopy = useCallback(() => {
    haptics.tap();
    // Tracked, so the hand-off is a row in the Transfers card with a retry.
    void trackedShare({
      label: "Diagnostics report",
      message: buildDiagnosticsReport(snapshot),
    }).then((outcome) => {
      if (outcome === "failed") {
        toast({ kind: "error", message: "Couldn't share the report." });
      }
    });
  }, [snapshot, toast, trackedShare]);

  const onRetryRevocations = useCallback(() => {
    setRetrying(true);
    void retryPendingPushRevocation()
      .then(() => {
        haptics.success();
        toast({ kind: "success", message: "Device revocations cleared." });
      })
      .catch(() => {
        haptics.error();
        toast({
          kind: "error",
          message: "That server is still unreachable. It stays queued.",
        });
      })
      .finally(() => {
        setRetrying(false);
        void readNativeState();
      });
  }, [readNativeState, toast]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Diagnostics"
        subtitle="Share this with support"
        onBack={goBackOrMore}
        right={
          <Pill
            label={freshness.label}
            tone={
              freshness.tone === "live"
                ? "success"
                : freshness.tone === "degraded"
                  ? "warning"
                  : "neutral"
            }
            accessibilityLabel={freshness.accessibilityLabel}
          />
        }
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 16 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
          />
        }
      >
        <Card>
          <SectionLabel topMargin={0}>This device</SectionLabel>
          {rows.map((row) => (
            <DiagnosticRow key={row.label} label={row.label} value={row.value} />
          ))}
        </Card>

        <Pressable
          onPress={onCopy}
          accessibilityRole="button"
          accessibilityLabel="Share a diagnostics report with support"
          accessibilityHint="Structural details only — no message, subscriber, or credential data"
          style={{
            minHeight: 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            backgroundColor: t.accent,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.accentFg,
              ...typeStyle("body"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            Share diagnostics
          </Text>
        </Pressable>

        <AppUpdateSection />

        {/* Beside the other support-facing state: this is the screen somebody
            opens when asked to explain what the app did. Self-gating. */}
        <IdempotencyLedgerCard />

        {revocations.length > 0 ? (
          <Card>
            <SectionLabel topMargin={0}>Stuck push revocations</SectionLabel>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              This device asked {revocations.length} server
              {revocations.length === 1 ? "" : "s"} to stop sending it
              notifications and never got an answer. Until this clears, that
              server may still push to this phone.
            </Text>
            <Pressable
              onPress={onRetryRevocations}
              disabled={retrying}
              accessibilityRole="button"
              accessibilityLabel="Retry pending push revocations"
              accessibilityState={{ disabled: retrying, busy: retrying }}
              style={{
                marginTop: 12,
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                borderWidth: 1,
                borderColor: t.border,
                opacity: retrying ? 0.6 : 1,
              }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.fg,
                  ...typeStyle("callout"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                {retrying ? "Retrying…" : "Retry now"}
              </Text>
            </Pressable>
          </Card>
        ) : null}

        <OfflineQueueSection model={queue} resolveOperationId={resolveOperationId} />

        {/* Every export, import and share this phone knows about, with
            cancel / retry / open / clear-history. Self-explains below admin. */}
        <TransfersSection />

        {/* The OTHER queue: side effects the server gave up on. Self-hides
            below admin, since it must never render "empty" as a 403. */}
        <OutboxDlqSection />
      </ScrollView>
    </SafeAreaView>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "flex-start",
        paddingVertical: 6,
        gap: 12,
      }}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      <Text
        selectable
        // A diagnostics VALUE is an id, an origin or a token fragment that
        // support asks the customer to read back — dense, copied verbatim,
        // never reflowed.
        {...typeCap("mono")}
        style={{
          color: t.fg,
          ...typeStyle("mono"),
          flexShrink: 1,
          // The value column hugs the TRAILING edge. RN's `textAlign` has no
          // logical `end`, and "right" is physical — on an RTL device the
          // flex row mirrors but the wrapped lines of a long id would keep
          // aligning to the physical right, i.e. the leading edge. Same
          // `I18nManager.isRTL` idiom the back chevron already uses.
          textAlign: I18nManager.isRTL ? "left" : "right",
          fontFamily: FONT.regular,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
