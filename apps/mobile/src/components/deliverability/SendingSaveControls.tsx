/**
 * components/deliverability/SendingSaveControls — save, discard, clear, and the
 * saved-at line beneath them.
 *
 * The last split of the sending-settings screen, and the one that finally put
 * SendingThrottleForm under its complexity ceiling. These controls decide
 * whether each action is offered at all, and the conditions are genuinely
 * five-deep: clearing the workspace limits requires that limits are configured,
 * that there are no unsaved edits, that no write is in flight, that the exact
 * revision is known, and that no unreconciled request is being held.
 *
 * Those five terms are the point rather than incidental complexity — each one
 * prevents a specific wrong outcome, from clobbering a newer policy to
 * clearing throttles while an earlier write's fate is still unknown. Keeping
 * them together in one component is what lets them be read as a set.
 */
import { ActivityIndicator, Pressable, Text } from "react-native";

import { ClearLimitsControl } from "@/components/deliverability/ClearLimitsControl";
import { SendingSecondaryButton as SecondaryButton } from "@/components/deliverability/SendingSettingsFields";
import type { useSendingSettingsForm } from "@/hooks/useSendingSettingsForm";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type Controller = ReturnType<typeof useSendingSettingsForm>;

export function SendingSaveControls({
  setForm,
  configured,
  dirty,
  busy,
  settingsStale,
  reconciliationHold,
  remoteBaselineChanged,
  hasError,
  onSave,
  onClear,
  savedAt,
  expectedRevision,
  initial,
}: {
  setForm: Controller["setForm"];
  configured: Controller["configured"];
  dirty: Controller["dirty"];
  busy: Controller["busy"];
  settingsStale: Controller["settingsStale"];
  reconciliationHold: Controller["reconciliationHold"];
  remoteBaselineChanged: Controller["remoteBaselineChanged"];
  hasError: Controller["hasError"];
  onSave: Controller["onSave"];
  onClear: Controller["onClear"];
  savedAt: Controller["savedAt"];
  expectedRevision: Controller["expectedRevision"];
  initial: Controller["initial"];
}) {
  const { t } = useTheme();
  const saveDisabled =
    !dirty ||
    hasError ||
    busy ||
    settingsStale ||
    expectedRevision === null ||
    reconciliationHold !== null ||
    remoteBaselineChanged;
  // The accessible name IS the visible text (WCAG 2.5.3 Label in Name), so a
  // Voice Control user can say what they see. The screen context a fixed
  // "Save sending settings" name used to carry is spoken as the hint instead.
  const saveText = busy ? "Saving…" : dirty ? "Save changes" : "No changes";
  return (
    <>
      <Pressable
        onPress={onSave}
        disabled={saveDisabled}
        accessibilityRole="button"
        accessibilityLabel={saveText}
        accessibilityHint="Saves this workspace's sending settings"
        accessibilityState={{
          disabled: saveDisabled,
          busy,
        }}
        style={{
          marginTop: 4,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: t.accent,
          alignItems: "center",
          justifyContent: "center",
          opacity: saveDisabled ? 0.5 : 1,
          flexDirection: "row",
          gap: 8,
        }}
      >
        {busy ? <ActivityIndicator size="small" color={t.accentFg} /> : null}
        <Text
          {...typeCap("body")}
          style={{
            color: t.accentFg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          {saveText}
        </Text>
      </Pressable>

      {dirty && !busy && !reconciliationHold && !remoteBaselineChanged ? (
        <SecondaryButton
          label="Discard changes"
          accessibilityLabel="Discard changes"
          onPress={() => {
            haptics.tap();
            setForm(initial);
          }}
        />
      ) : null}

      <ClearLimitsControl
        configured={configured}
        dirty={dirty}
        busy={busy}
        settingsStale={settingsStale}
        reconciliationHold={reconciliationHold}
        expectedRevision={expectedRevision}
        onClear={onClear}
      />

      {savedAt ? (
        <Text
          {...typeCap("badgeSmall")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("badgeSmall"),
            textAlign: "center",
            marginTop: 12,
            fontVariant: ["tabular-nums"],
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {`Last saved ${dateTime(savedAt)}`}
        </Text>
      ) : null}
    </>
  );
}
