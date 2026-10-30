/**
 * components/deliverability/SendingSettingsBody — the form half of the
 * sending-settings screen.
 *
 * Extracted because the screen's surface function carried cyclomatic
 * complexity 45 against a recorded ratchet of 30. Nearly all of it lived in
 * this one branch: ~295 lines of form rendered only once the settings read has
 * both loaded and succeeded, with ~40 conditional expressions inside it
 * (per-field errors, the reconciliation hold, DST and timezone advisories, the
 * saved-at line, and the dirty/error gating on the save controls).
 *
 * The screen now decides loading / failed / ready and nothing else. Behaviour
 * is unchanged: this is the same markup, reading the same controller values,
 * which arrive as props instead of closure bindings.
 */
import { Pressable, Text, View } from "react-native";

import { SendingConfigSummary } from "@/components/deliverability/SendingConfigSummary";
import { SendingThrottleForm } from "@/components/deliverability/SendingThrottleForm";
import { SendingStatusCard } from "@/components/deliverability/SendingStatusCard";
import type { useSendingSettingsForm } from "@/hooks/useSendingSettingsForm";
import { useAnnounceOnChange } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The three hold banners, as sentences, so the words painted and the words
 * spoken cannot drift. Each pauses editing, and an alert-role node is silent
 * on iOS (lib/a11y.ts), so the one showing is also announced. The mutation
 * error banner is not: its message is toasted when it is set (useSendingWrites
 * pairs every setMutationError with a toast), and Toast speaks.
 */
const REVISION_UNKNOWN =
  "The exact settings revision is unavailable. Refresh before editing so this view cannot overwrite a newer policy.";
const VERIFICATION_STALE =
  "The latest verification refresh failed. Last verified settings remain visible, and editing is paused until they can be checked again.";
const NEWER_SETTINGS =
  "Newer sending settings arrived. Your draft has not been overwritten. Saving is paused until you load the current server version.";

interface SendingSettingsBodyProps {
  now: ReturnType<typeof useSendingSettingsForm>["now"];
  status: ReturnType<typeof useSendingSettingsForm>["status"];
  row: ReturnType<typeof useSendingSettingsForm>["row"];
  initial: ReturnType<typeof useSendingSettingsForm>["initial"];
  form: ReturnType<typeof useSendingSettingsForm>["form"];
  setForm: ReturnType<typeof useSendingSettingsForm>["setForm"];
  mutationError: ReturnType<typeof useSendingSettingsForm>["mutationError"];
  reconciliationHold: ReturnType<
    typeof useSendingSettingsForm
  >["reconciliationHold"];
  remoteBaselineChanged: ReturnType<
    typeof useSendingSettingsForm
  >["remoteBaselineChanged"];
  adoptRemoteBaseline: ReturnType<
    typeof useSendingSettingsForm
  >["adoptRemoteBaseline"];
  reconciling: ReturnType<typeof useSendingSettingsForm>["reconciling"];
  endRef: ReturnType<typeof useSendingSettingsForm>["endRef"];
  tzRef: ReturnType<typeof useSendingSettingsForm>["tzRef"];
  dirty: ReturnType<typeof useSendingSettingsForm>["dirty"];
  fieldErrors: ReturnType<typeof useSendingSettingsForm>["fieldErrors"];
  hasError: ReturnType<typeof useSendingSettingsForm>["hasError"];
  savedAt: ReturnType<typeof useSendingSettingsForm>["savedAt"];
  expectedRevision: ReturnType<
    typeof useSendingSettingsForm
  >["expectedRevision"];
  configured: ReturnType<typeof useSendingSettingsForm>["configured"];
  dst: ReturnType<typeof useSendingSettingsForm>["dst"];
  deviceTz: ReturnType<typeof useSendingSettingsForm>["deviceTz"];
  busy: ReturnType<typeof useSendingSettingsForm>["busy"];
  settingsStale: ReturnType<typeof useSendingSettingsForm>["settingsStale"];
  retrySettingsVerification: () => Promise<unknown>;
  reconcilePending: ReturnType<
    typeof useSendingSettingsForm
  >["reconcilePending"];
  adoptCurrentServerVersion: ReturnType<
    typeof useSendingSettingsForm
  >["adoptCurrentServerVersion"];
  statusReason: ReturnType<typeof useSendingSettingsForm>["statusReason"];
  onSave: ReturnType<typeof useSendingSettingsForm>["onSave"];
  onClear: ReturnType<typeof useSendingSettingsForm>["onClear"];
}

export function SendingSettingsBody({
  now,
  status,
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
  retrySettingsVerification,
  reconcilePending,
  adoptCurrentServerVersion,
  statusReason,
  onSave,
  onClear,
}: SendingSettingsBodyProps) {
  const { t } = useTheme();
  const revisionUnknown = Boolean(row) && expectedRevision === null;
  // The most urgent of the banners on screen, most actionable first.
  useAnnounceOnChange(
    remoteBaselineChanged
      ? NEWER_SETTINGS
      : settingsStale
        ? VERIFICATION_STALE
        : revisionUnknown
          ? REVISION_UNKNOWN
          : null,
  );
  return (
    <>
      <SendingStatusCard
        status={status.data}
        unavailable={!status.data}
        unavailableReason={statusReason}
        now={now}
      />

      <SendingConfigSummary row={row} configured={configured} />

      {revisionUnknown ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("label")}
          style={{
            color: t.warning,
            ...typeStyle("label"),
            marginBottom: 12,
            fontFamily: FONT.regular,
          }}
        >
          {REVISION_UNKNOWN}
        </Text>
      ) : null}

      {settingsStale ? (
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.warning,
            borderWidth: 1,
            borderRadius: 12,
            padding: 14,
            marginBottom: 14,
          }}
        >
          <Text
            accessibilityRole="alert"
            {...typeCap("label")}
            style={{
              color: t.warning,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {VERIFICATION_STALE}
          </Text>
          <Pressable
            onPress={() => void retrySettingsVerification()}
            accessibilityRole="button"
            accessibilityLabel="Retry sending settings verification"
            style={{
              minHeight: 44,
              justifyContent: "center",
              alignSelf: "flex-start",
              marginTop: 8,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              Retry verification
            </Text>
          </Pressable>
        </View>
      ) : null}

      {remoteBaselineChanged ? (
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.warning,
            borderWidth: 1,
            borderRadius: 12,
            padding: 14,
            marginBottom: 14,
          }}
        >
          <Text
            accessibilityRole="alert"
            {...typeCap("label")}
            style={{
              color: t.warning,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {NEWER_SETTINGS}
          </Text>
          <Pressable
            onPress={adoptRemoteBaseline}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Discard draft and load current sending settings"
            accessibilityState={{ disabled: busy, busy }}
            style={{
              minHeight: 44,
              justifyContent: "center",
              alignSelf: "flex-start",
              marginTop: 8,
              opacity: busy ? 0.5 : 1,
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              Discard draft &amp; load current
            </Text>
          </Pressable>
        </View>
      ) : null}

      {mutationError ? (
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.danger,
            borderWidth: 1,
            borderRadius: 12,
            padding: 14,
            marginBottom: 14,
          }}
        >
          <Text
            accessibilityRole="alert"
            {...typeCap("label")}
            style={{
              color: t.danger,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {mutationError} Your draft is still here.
          </Text>
          {reconciliationHold ? (
            <Pressable
              onPress={
                reconciliationHold.currentSettings
                  ? adoptCurrentServerVersion
                  : () => void reconcilePending()
              }
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={
                reconciliationHold.currentSettings
                  ? "Load current server settings"
                  : "Refresh to reconcile sending settings"
              }
              accessibilityState={{ disabled: busy, busy }}
              style={{
                minHeight: 44,
                justifyContent: "center",
                alignSelf: "flex-start",
                marginTop: 8,
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accent,
                  ...typeStyle("callout"),
                  fontFamily: FONT.semibold,
                }}
              >
                {reconciliationHold.currentSettings
                  ? "Load current server version"
                  : reconciling
                    ? "Reconciling…"
                    : "Refresh to reconcile"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <SendingThrottleForm
        row={row}
        form={form}
        setForm={setForm}
        fieldErrors={fieldErrors}
        endRef={endRef}
        tzRef={tzRef}
        deviceTz={deviceTz}
        dst={dst}
        configured={configured}
        dirty={dirty}
        busy={busy}
        settingsStale={settingsStale}
        reconciliationHold={reconciliationHold}
        remoteBaselineChanged={remoteBaselineChanged}
        hasError={hasError}
        onSave={onSave}
        onClear={onClear}
        savedAt={savedAt}
        initial={initial}
        expectedRevision={expectedRevision}
      />
    </>
  );
}
