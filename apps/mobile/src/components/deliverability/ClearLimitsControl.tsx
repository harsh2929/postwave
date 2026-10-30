/**
 * components/deliverability/ClearLimitsControl — the "remove workspace limits"
 * action, and the five conditions that decide whether it is offered.
 *
 * It lives alone because those five terms ARE the component. Removing every
 * throttle is not a typo-recoverable edit: it takes effect on the next batch,
 * so the control appears only when all of the following hold.
 *
 *   configured                 there are limits to remove
 *   !dirty                     no unsaved edits that clearing would silently discard
 *   !busy                      no write already in flight
 *   expectedRevision !== null  the exact revision is known, so this cannot
 *                              overwrite a policy someone else just changed
 *   !reconciliationHold        no earlier write whose outcome is still unknown
 *
 * Written out because the chain reads as incidental complexity and is not:
 * drop any one term and there is a specific way to clear a workspace's sending
 * protections by accident.
 */
import { SendingSecondaryButton as SecondaryButton } from "@/components/deliverability/SendingSettingsFields";
import type { useSendingSettingsForm } from "@/hooks/useSendingSettingsForm";

type Controller = ReturnType<typeof useSendingSettingsForm>;

export function ClearLimitsControl({
  configured,
  dirty,
  busy,
  settingsStale,
  reconciliationHold,
  expectedRevision,
  onClear,
}: {
  configured: Controller["configured"];
  dirty: Controller["dirty"];
  busy: Controller["busy"];
  settingsStale: Controller["settingsStale"];
  reconciliationHold: Controller["reconciliationHold"];
  expectedRevision: Controller["expectedRevision"];
  onClear: Controller["onClear"];
}) {
  return (
    <>
      {configured &&
      !dirty &&
      !busy &&
      !settingsStale &&
      expectedRevision !== null &&
      !reconciliationHold ? (
        // Named by the words it shows (WCAG 2.5.3 Label in Name): a Voice
        // Control user says what they see. What it removes is the hint.
        <SecondaryButton
          label="Remove all throttles"
          accessibilityLabel="Remove all throttles"
          accessibilityHint="Removes the send cap and quiet hours"
          tone="danger"
          onPress={() => void onClear()}
        />
      ) : null}
    </>
  );
}
