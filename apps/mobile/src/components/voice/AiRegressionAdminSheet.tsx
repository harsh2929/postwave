/**
 * AiRegressionAdminSheet — tune the harness, then re-run it.
 *
 * Two admin verbs in one sheet because they are one decision: the thresholds
 * decide what a run's outcome is RECORDED as, and the trigger is what produces
 * an outcome to record.
 *
 * THE COPY DOES NOT OVERCLAIM. The hard gate does not block a release by
 * itself — ComputeGate only lets a run be recorded as `fail` when the gate is
 * on AND at least `min_examples_for_gate` examples actually scored. That
 * sentence is rendered live from the current draft
 * (lib/aiRegressionAdmin.recordingPolicySentence) so the operator reads the
 * consequence of the values in front of them, not a generic blurb.
 *
 * The PUT is a WHOLE-OBJECT REPLACE, so all four fields are seeded from the
 * fetched settings and sent together; Save is disabled when nothing changed.
 *
 * Trigger refusals (409 in-flight, 422 no golden examples, 503 executor not
 * configured) are the server's own sentences and carry NO retry — pressing
 * again cannot change any of them.
 */
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SkeletonCard } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain, type FocusableRef } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  buildSettingsPut,
  buildTriggerRunBody,
  recordingPolicySentence,
  settingsUnchanged,
  type RegressionSettingsView,
} from "@/lib/aiRegressionAdmin";

export function AiRegressionAdminSheet({
  visible,
  settings,
  loading,
  loadError,
  saving,
  triggering,
  triggerError,
  onSave,
  onTrigger,
  onClose,
}: {
  visible: boolean;
  settings: RegressionSettingsView | null;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  triggering: boolean;
  triggerError: string | null;
  onSave: (body: {
    warn_threshold: number;
    hard_gate_enabled: boolean;
    hard_gate_threshold: number;
    min_examples_for_gate: number;
  }) => void;
  onTrigger: (body: { model_version_tag: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const [warn, setWarn] = useState("");
  const [hardOn, setHardOn] = useState(false);
  const [hard, setHard] = useState("");
  const [minExamples, setMinExamples] = useState("");
  const [tag, setTag] = useState("");
  const [touched, setTouched] = useState(false);
  const [runTouched, setRunTouched] = useState(false);
  // The return key walks the three threshold fields and then saves; the model
  // tag is its own one-field form and submits the replay.
  const hardRef = useRef<TextInput>(null);
  const minExamplesRef = useRef<TextInput>(null);

  // Seed from the server's values, and re-seed whenever they change (a save
  // returns the stored row, which may differ from what was typed).
  useEffect(() => {
    if (!visible || !settings) return;
    setWarn(String(settings.warnThreshold));
    setHardOn(settings.hardGateEnabled);
    setHard(String(settings.hardGateThreshold));
    setMinExamples(String(settings.minExamplesForGate));
    setTouched(false);
  }, [visible, settings]);

  useEffect(() => {
    if (visible) return;
    setTag("");
    setRunTouched(false);
  }, [visible]);

  if (!visible) return null;

  const built = buildSettingsPut({
    warnThreshold: warn,
    hardGateEnabled: hardOn,
    hardGateThreshold: hard,
    minExamplesForGate: minExamples,
  });
  const unchanged =
    built.ok && settings ? settingsUnchanged(settings, built.body) : false;
  const settingsError = touched && !built.ok ? built.error : null;

  // The live consequence sentence reads the DRAFT when it parses, so the
  // operator sees what they are about to save rather than what is stored.
  const preview: RegressionSettingsView | null = built.ok
    ? {
        warnThreshold: built.body.warn_threshold,
        hardGateEnabled: built.body.hard_gate_enabled,
        hardGateThreshold: built.body.hard_gate_threshold,
        minExamplesForGate: built.body.min_examples_for_gate,
      }
    : settings;

  const run = buildTriggerRunBody(tag);
  const runError = runTouched && !run.ok ? run.error : null;

  // One code path per verb, so the return key and the button cannot drift.
  const saveSettings = () => {
    setTouched(true);
    if (!built.ok) return;
    haptics.tap();
    onSave(built.body);
  };
  const triggerRun = () => {
    setRunTouched(true);
    if (!run.ok) return;
    haptics.tap();
    onTrigger(run.body);
  };

  return (
    <KeyboardFormSheet
      visible
      onClose={onClose}
      accessibilityLabel="AI regression administration"
      contentContainerStyle={{ gap: 14 }}
    >
      <Text
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Regression settings
      </Text>

      {loading ? (
        <SkeletonCard lines={3} />
      ) : loadError ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {loadError}
        </Text>
      ) : (
        <>
          <NumberField
            label="Warn threshold"
            hint="Below this score a run is recorded as a warning (0–100)."
            value={warn}
            onChange={(v) => {
              setTouched(true);
              setWarn(v);
            }}
            editable={!saving}
            next={hardRef}
          />

          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.regular,
                flex: 1,
              }}
            >
              Record failures (hard gate)
            </Text>
            <Switch
              accessibilityLabel="Record failures using the hard gate"
              value={hardOn}
              disabled={saving}
              onValueChange={(v) => {
                haptics.tap();
                setTouched(true);
                setHardOn(v);
              }}
            />
          </View>

          <NumberField
            label="Hard gate threshold"
            hint="With the gate on, a run below this is recorded as a failure (0–100)."
            value={hard}
            onChange={(v) => {
              setTouched(true);
              setHard(v);
            }}
            editable={!saving && hardOn}
            inputRef={hardRef}
            next={minExamplesRef}
          />
          <NumberField
            label="Minimum scored examples"
            hint="Fewer than this and the outcome stays advisory, whatever the score."
            value={minExamples}
            onChange={(v) => {
              setTouched(true);
              setMinExamples(v);
            }}
            editable={!saving}
            inputRef={minExamplesRef}
            onSubmit={saveSettings}
          />

          {preview ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {recordingPolicySentence(preview)}
            </Text>
          ) : null}

          {settingsError ? (
            <Text
              {...typeCap("bodySmall")}
              accessibilityLiveRegion="polite"
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {settingsError}
            </Text>
          ) : null}

          <SheetButton
            label={saving ? "Saving…" : unchanged ? "No changes" : "Save settings"}
            disabled={saving || unchanged}
            onPress={saveSettings}
          />
        </>
      )}

      <View style={{ height: 1, backgroundColor: t.border }} />

      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "500",
          fontFamily: FONT.medium,
        }}
      >
        Trigger a replay
      </Text>
      <TextInput
        accessibilityLabel="Model version label"
        placeholder="Model version label"
        placeholderTextColor={t.fgSubtle}
        value={tag}
        onChangeText={setTag}
        editable={!triggering}
        autoCapitalize="none"
        // A TextInput scales with the OS text setting exactly like a Text, and
        // its 44pt minHeight does not, so an uncapped input clips its caret at
        // accessibility sizes.
        {...typeCap("body")}
        {...keyboardChain({ onSubmit: triggerRun, disabled: triggering })}
        style={{
          color: t.fg,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          minHeight: 44,
          fontFamily: FONT.regular,
        }}
      />
      {runError || triggerError ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {runError ?? triggerError}
        </Text>
      ) : null}
      <SheetButton
        label={triggering ? "Starting…" : "Run the harness"}
        disabled={triggering}
        onPress={triggerRun}
      />
    </KeyboardFormSheet>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  editable,
  inputRef,
  next,
  onSubmit,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  editable: boolean;
  /** Set when a PRECEDING field's return key focuses this one. */
  inputRef?: RefObject<TextInput | null>;
  /** The field this one's return key advances to. */
  next?: FocusableRef;
  /** Terminal action for the last field of the chain. */
  onSubmit?: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <TextInput
        ref={inputRef}
        accessibilityLabel={label}
        accessibilityHint={hint}
        value={value}
        onChangeText={onChange}
        editable={editable}
        keyboardType="numeric"
        // An input scales with the OS text setting while its 44pt minHeight
        // does not, so an uncapped field clips its own caret.
        {...typeCap("body")}
        {...keyboardChain({ next, onSubmit })}
        style={{
          color: editable ? t.fg : t.fgSubtle,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          minHeight: 44,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      />
    </View>
  );
}

function SheetButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: disabled ? t.fgSubtle : t.accent,
          ...typeStyle("body"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
