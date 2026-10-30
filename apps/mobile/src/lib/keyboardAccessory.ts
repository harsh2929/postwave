/**
 * keyboardAccessory — which keyboards leave the user with no way out.
 *
 * On iOS the numeric keyboards (`number-pad`, `decimal-pad`, `numeric`,
 * `phone-pad`, `ascii-number-pad`) ship NO return key. `returnKeyType="done"`
 * is silently ignored on them, so the only way to dismiss the keyboard is to
 * tap somewhere else on the screen — and several of this app's numeric inputs
 * live inside a Modal, where an outside tap is bound to DISMISS THE SHEET. The
 * user's only route to closing the keyboard is therefore to throw away the
 * edit they were making.
 *
 * `InputAccessoryView` fixes it by putting a Done bar above the keyboard, but
 * it is iOS-only and it must not be attached to keyboards that already have a
 * return key — a second Done above a keyboard that has one is noise.
 *
 * Pure and import-free (no react-native import) so the policy is testable in
 * the node vitest environment; the component that consumes it lives in
 * components/settings/FormControls.tsx.
 */

/**
 * The `keyboardType` values that render WITHOUT a return key on iOS.
 *
 * `numbers-and-punctuation` is deliberately absent: it is a full keyboard with
 * a return key, so it needs no accessory.
 */
const RETURN_KEYLESS_IOS_KEYBOARDS = new Set([
  "number-pad",
  "decimal-pad",
  "numeric",
  "phone-pad",
  "ascii-number-pad",
]);

/**
 * Whether an input with this keyboard needs a Done accessory bar.
 *
 * `platform` is passed in rather than read from `Platform.OS` so this module
 * stays import-free and both branches are testable.
 */
export function needsDoneAccessory(
  keyboardType: string | undefined,
  platform: string,
): boolean {
  if (platform !== "ios") return false;
  if (!keyboardType) return false;
  return RETURN_KEYLESS_IOS_KEYBOARDS.has(keyboardType);
}

/**
 * Whether `returnKeyType="done"` is actually honoured for this keyboard. Used
 * to decide whether setting it is meaningful or merely decorative — a "done"
 * return key configured on a number pad is a promise the OS will not keep.
 */
export function honoursReturnKey(
  keyboardType: string | undefined,
  platform: string,
): boolean {
  if (platform !== "ios") return true;
  if (!keyboardType) return true;
  return !RETURN_KEYLESS_IOS_KEYBOARDS.has(keyboardType);
}

/**
 * A stable, collision-free nativeID for one input's accessory view.
 *
 * Two `InputAccessoryView`s sharing a nativeID is undefined behaviour in RN —
 * the OS picks one — so every input gets its own, derived from React's
 * `useId()` (which is unique per component instance) rather than from the
 * field label, which repeats across sections.
 */
export function accessoryIdFor(instanceId: string): string {
  return `pw-done-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
