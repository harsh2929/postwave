/**
 * keyboardChain — the return key's job, decided once.
 *
 * THE DEFECT THIS REPLACES. An audit of every `TextInput` in the app found
 * `returnKeyType` on 15 of 53 and `onSubmitEditing` on 8, and `blurOnSubmit` /
 * `submitBehavior` on none. In practice that means: the return key on most
 * fields did nothing, so filling a multi-field form (the API-connection
 * section's three fields, the account-deletion confirmation's two, the
 * outbound-webhook form's two, the sequence step editor's five) required
 * dismissing the keyboard and tapping the next field by hand, every time.
 * Field-to-field chaining is the platform-standard behaviour on iOS, and its
 * absence is felt on every single form.
 *
 * Three details are easy to get wrong independently at 30 call sites, which is
 * why they are decided here instead:
 *
 *  1. THE KEY CAP. A field with somewhere to go shows "next"; the last field
 *     in a chain shows the terminal cap — "go" when it submits the form,
 *     "done" when it only dismisses.
 *  2. `submitBehavior`. On a MULTILINE field the default is "newline", which
 *     swallows the return key entirely, so `onSubmitEditing` never fires. It
 *     must be set explicitly for a multiline field to be submittable at all.
 *     (The old `blurOnSubmit` spelling is deprecated in this React Native.)
 *  3. THE KEYBOARD MUST NOT FLICKER. When focus moves to a SIBLING, blurring
 *     first makes iOS dismiss and immediately re-raise the keyboard — a visible
 *     bounce between two fields of the same form. "submit" keeps it up.
 *     Only a terminal action that is finished with the keyboard blurs.
 *
 * Deliberately import-free — including of react-native — so the decision table
 * is unit-tested in the node environment rather than eyeballed on a simulator.
 * The ref is accepted structurally (anything with `.focus()`), which is what a
 * `RefObject<TextInput>` satisfies.
 */

/** Anything focusable: a `RefObject<TextInput | null>` satisfies this. */
export interface FocusableRef {
  readonly current: { focus: () => void } | null;
}

export type ReturnKeyCap = "next" | "go" | "done" | "send" | "search";

export type SubmitBehaviorValue = "submit" | "blurAndSubmit" | "newline";

export interface KeyboardChainInput {
  /**
   * The field the return key should move to. Wins over `onSubmit`: a field in
   * the middle of a chain advances, it does not submit.
   */
  next?: FocusableRef | undefined;
  /** Terminal action for the LAST field in a chain. */
  onSubmit?: (() => void) | undefined;
  /** True for a `multiline` field — changes the default submit behaviour. */
  multiline?: boolean | undefined;
  /**
   * Override the key cap when neither default reads right ("search" on a
   * filter field, "send" on a message composer).
   */
  returnKeyType?: ReturnKeyCap | undefined;
  /**
   * True when the terminal action is not available yet (an invalid form, a
   * submit already in flight). The key cap still renders so the keyboard does
   * not change shape under the user, but the action is not wired.
   */
  disabled?: boolean | undefined;
}

/**
 * Props to spread onto a `TextInput`. Optional keys are ABSENT rather than
 * `undefined` so this composes under `exactOptionalPropertyTypes`, and so a
 * field with nothing to do keeps React Native's own defaults instead of being
 * handed an explicit `undefined` that overrides a `{...rest}` spread.
 */
export interface KeyboardChainProps {
  returnKeyType?: ReturnKeyCap;
  submitBehavior?: SubmitBehaviorValue;
  onSubmitEditing?: () => void;
}

export function keyboardChain(input: KeyboardChainInput): KeyboardChainProps {
  const advancing = Boolean(input.next);
  const action = input.next
    ? () => input.next?.current?.focus()
    : input.onSubmit;

  // Nothing to do on return, and not multiline: leave the platform default
  // alone. A multiline field with no action keeps "newline", which is right.
  if (!action) {
    return input.returnKeyType ? { returnKeyType: input.returnKeyType } : {};
  }

  const cap: ReturnKeyCap =
    input.returnKeyType ?? (advancing ? "next" : "go");

  // Advancing to a sibling keeps the keyboard up; a terminal submit is done
  // with it. A multiline field must say so explicitly or the return key is
  // consumed as a newline and no submit ever fires.
  const behavior: SubmitBehaviorValue = advancing ? "submit" : "blurAndSubmit";

  if (input.disabled) {
    return { returnKeyType: cap, submitBehavior: behavior };
  }
  return {
    returnKeyType: cap,
    submitBehavior: behavior,
    onSubmitEditing: action,
  };
}

/**
 * The terminal field of a chain whose action only DISMISSES the keyboard —
 * a lone search box, a field whose form is submitted by a button. "done" is
 * the honest cap: "go" promises a submit that will not happen.
 */
export function keyboardDismiss(): KeyboardChainProps {
  return { returnKeyType: "done", submitBehavior: "blurAndSubmit" };
}
