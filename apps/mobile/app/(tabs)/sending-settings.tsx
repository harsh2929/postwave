/**
 * Sending settings — the throttle + quiet-hours config the sending worker
 * reads before each batch, plus operational quiet/cap coordination state.
 *
 * This is the one deliverability surface that is genuinely edit-friendly on a
 * phone: an operator at 11pm seeing "we're sending during quiet hours" needs to
 * fix the window without a laptop.
 *
 * What changed, and why:
 *
 *  - IT NO LONGER ASSERTS A MISSING WORKSPACE CAP WHILE OFFLINE. The read was a
 *    plain gated query, so offline it produced `data === undefined` with
 *    isLoading and isError both false — and the render guard let that through,
 *    printing a definitive statement about a compliance control it had never
 *    loaded. The read is snapshot-backed now and its provenance is on screen.
 *  - IT POLLS OPERATIONAL STATUS for quiet-hours and cap coordination. The
 *    current endpoint deliberately marks counter telemetry unavailable, so a
 *    numeric hourly meter stays withheld until a tenant-safe shared counter
 *    contract exists instead of turning an absent count into zero.
 *  - FEEDBACK IS A TOAST, NOT A MODAL. A blocking Alert for a successful save
 *    costs a second tap to dismiss the good news.
 *  - EDITS SURVIVE THE BACK GESTURE. A dirty form used to be discarded in
 *    silence.
 *  - THROTTLES CAN BE CLEARED. Reverting to unthrottled meant blanking four
 *    fields by hand and hoping the all-or-nothing rule was satisfied.
 */
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CachedNotice } from "@/components/deliverability/CachedNotice";
import { SendingSettingsBody } from "@/components/deliverability/SendingSettingsBody";
import { ErrorState } from "@/components/ErrorState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonCard } from "@/components/Skeleton";
import { useSendingSettingsForm } from "@/hooks/useSendingSettingsForm";
import {
  onlineQueryAuthorityOwner,
  useOnlineQueryGate,
} from "@/hooks/useOnlineQueryGate";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function SendingSettings() {
  const gate = useOnlineQueryGate();
  return (
    <SendingSettingsSurface
      key={`sending-settings:${onlineQueryAuthorityOwner(gate)}`}
    />
  );
}

function SendingSettingsSurface() {
  const { t } = useTheme();
  const {
    now,
    settings,
    status,
    refresh,
    row,
    initial,
    form,
    setForm,
    mutationError,
    reconciliationHold,
    remoteBaselineChanged,
    adoptRemoteBaseline,
    reconciling,
    endRef,
    tzRef,
    dirty,
    fieldErrors,
    hasError,
    savedAt,
    expectedRevision,
    configured,
    dst,
    deviceTz,
    busy,
    settingsStale,
    reconcilePending,
    adoptCurrentServerVersion,
    statusReason,
    onSave,
    onClear,
    onBack,
    loading,
    failed,
    settingsUnavailableOffline,
  } = useSendingSettingsForm();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Sending settings"
        subtitle={dirty ? "Unsaved changes" : undefined}
        onBack={() => void onBack()}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 64 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refresh.refreshing}
              onRefresh={refresh.onRefresh}
              tintColor={t.fgMuted}
              colors={[t.accent]}
            />
          }
        >
          <CachedNotice backing={settings.data} now={now} />

          {loading ? <SkeletonCard lines={4} /> : null}

          {failed ? (
            <ErrorState
              error={settings.error}
              {...(settingsUnavailableOffline
                ? {
                    message:
                      "No saved copy of your sending settings is available offline. Reconnect to verify this workspace before editing.",
                  }
                : {})}
              onRetry={() => void settings.refetch()}
            />
          ) : null}

          {!loading && !failed ? (
            <SendingSettingsBody
              now={now}
              status={status}
              row={row}
              initial={initial}
              form={form}
              setForm={setForm}
              mutationError={mutationError}
              reconciliationHold={reconciliationHold}
              remoteBaselineChanged={remoteBaselineChanged}
              adoptRemoteBaseline={adoptRemoteBaseline}
              reconciling={reconciling}
              endRef={endRef}
              tzRef={tzRef}
              dirty={dirty}
              fieldErrors={fieldErrors}
              hasError={hasError}
              savedAt={savedAt}
              expectedRevision={expectedRevision}
              configured={configured}
              dst={dst}
              deviceTz={deviceTz}
              busy={busy}
              settingsStale={settingsStale}
              retrySettingsVerification={settings.refetch}
              reconcilePending={reconcilePending}
              adoptCurrentServerVersion={adoptCurrentServerVersion}
              statusReason={statusReason}
              onSave={onSave}
              onClear={onClear}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
