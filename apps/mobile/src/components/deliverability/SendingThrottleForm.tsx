/**
 * components/deliverability/SendingThrottleForm — the editable half of the
 * sending-settings screen.
 *
 * Third and final split of what began as one 1026-line screen. The screen now
 * decides loading / failed / ready; SendingSettingsBody renders the read-only
 * status, summary and advisory notices; this owns the four editable fields and
 * the save and clear controls.
 *
 * The seam is the read/write line, not an arbitrary line count: the
 * conditional density that pushed the previous component past its complexity
 * ceiling is almost all here — per-field validation errors, the
 * device-timezone and DST advisories, and the dirty/error/hold gating that
 * decides whether saving is offered at all.
 *
 * Same markup and the same controller values, now arriving as props.
 */
import { IpPoolCard } from "@/components/deliverability/IpPoolCard";
import { QuietHoursAdvisories } from "@/components/deliverability/QuietHoursAdvisories";
import { RecipientTimezoneCard } from "@/components/deliverability/RecipientTimezoneCard";
import { SendingSaveControls } from "@/components/deliverability/SendingSaveControls";
import { SendingField as Field } from "@/components/deliverability/SendingSettingsFields";
import type { useSendingSettingsForm } from "@/hooks/useSendingSettingsForm";

type Controller = ReturnType<typeof useSendingSettingsForm>;

interface SendingThrottleFormProps {
  row: Controller["row"];
  form: Controller["form"];
  setForm: Controller["setForm"];
  fieldErrors: Controller["fieldErrors"];
  endRef: Controller["endRef"];
  tzRef: Controller["tzRef"];
  deviceTz: Controller["deviceTz"];
  dst: Controller["dst"];
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
  initial: Controller["initial"];
  expectedRevision: Controller["expectedRevision"];
}

export function SendingThrottleForm({
  row,
  form,
  setForm,
  fieldErrors,
  endRef,
  tzRef,
  deviceTz,
  dst,
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
  initial,
  expectedRevision,
}: SendingThrottleFormProps) {
  const editingHeld =
    settingsStale || reconciliationHold !== null || remoteBaselineChanged;
  return (
    <>
      <Field
        label="Max sends per hour"
        hint="Blank means no workspace-specific ceiling; provider, quota, and safety controls still apply. A configured cap pauses new batches once reached."
        value={form.maxSendsPerHour}
        onChangeText={(v) => setForm((f) => ({ ...f, maxSendsPerHour: v }))}
        placeholder="e.g. 5000"
        keyboardType="number-pad"
        error={fieldErrors.maxSendsPerHour}
        disabled={editingHeld}
      />
      <Field
        label="Quiet hours start"
        hint="24-hour HH:MM in the timezone below. Inclusive."
        value={form.quietStart}
        onChangeText={(v) => setForm((f) => ({ ...f, quietStart: v }))}
        placeholder="22:00"
        // A time is digits and a colon: the alphabetic keyboard made
        // the operator switch planes twice to type "22:00".
        keyboardType="numbers-and-punctuation"
        returnKeyType="next"
        onSubmitEditing={() => endRef.current?.focus()}
        error={fieldErrors.quietStart}
        disabled={editingHeld}
      />
      <Field
        inputRef={endRef}
        label="Quiet hours end"
        hint="24-hour HH:MM. Exclusive."
        value={form.quietEnd}
        onChangeText={(v) => setForm((f) => ({ ...f, quietEnd: v }))}
        placeholder="07:00"
        keyboardType="numbers-and-punctuation"
        returnKeyType="next"
        onSubmitEditing={() => tzRef.current?.focus()}
        error={fieldErrors.quietEnd}
        disabled={editingHeld}
      />
      <Field
        inputRef={tzRef}
        label="Quiet hours timezone"
        hint="IANA timezone name. All three quiet-hours fields are required together."
        value={form.quietTz}
        onChangeText={(v) => setForm((f) => ({ ...f, quietTz: v }))}
        placeholder="America/New_York"
        returnKeyType="done"
        error={fieldErrors.quietTz}
        disabled={editingHeld}
      />

      <QuietHoursAdvisories
        quietTz={form.quietTz}
        deviceTz={deviceTz}
        dst={dst}
        setForm={setForm}
        disabled={editingHeld}
      />

      <RecipientTimezoneCard
        value={form.perRecipient}
        disabled={editingHeld}
        onChange={(value) =>
          setForm((current) => ({ ...current, perRecipient: value }))
        }
      />

      <IpPoolCard row={row} />

      <SendingSaveControls
        setForm={setForm}
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
        expectedRevision={expectedRevision}
        initial={initial}
      />
    </>
  );
}
