/**
 * ConfirmSheet — the app's confirmation primitive for consequential actions.
 *
 * Replaces `Alert.alert` for the cases that genuinely need a pre-confirm. Three
 * concrete problems with `Alert` that this fixes:
 *
 *  1. IT IS UNSTYLED AND UNBRANDED. `Alert` renders the OS dialog, so the app's
 *     most consequential moments are the only ones that don't look like the app.
 *  2. ITS API IS A CALLBACK PYRAMID. `Alert.alert(t, m, [{...onPress}])` cannot
 *     be awaited, so every destructive flow in this codebase is written inside
 *     out. Here it is `if (await confirm({...})) { ... }`.
 *  3. IT CANNOT ESCALATE. Deleting one suppression entry and wiping a whole
 *     workspace get the identical two-button dialog. This sheet supports a
 *     `confirmPhrase` gate that requires the user to type the resource's name —
 *     the standard treatment for irreversible, high-blast-radius actions.
 *
 * Choosing between this and Toast-with-Undo: if the action is REVERSIBLE, skip
 * the confirm entirely and give the user an undo (see Toast). Reserve this for
 * actions that cannot be taken back — the confirm dialog's value comes from
 * being rare enough that people still read it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { confirmPhraseSatisfied } from "@/lib/feedbackPolicy";
import { FONT } from "@/lib/fonts";
import { focusOn } from "@/lib/a11y";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardChain } from "@/lib/keyboardChain";

/**
 * How long to wait after dismissal before moving screen-reader focus.
 * A modal's exit transition has to finish first or the target is not yet in
 * the active accessibility tree and the call is silently dropped. Comfortably
 * longer than the sheet's own exit, and short enough that the user has not
 * started swiping.
 */
const FOCUS_RESTORE_DELAY_MS = 350;

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Label of the affirmative button. Prefer a verb: "Suppress", not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the affirmative button in the danger colour. */
  destructive?: boolean;
  /**
   * When set, the affirmative button stays disabled until the user types this
   * exact string. Use the resource's own name so the typing is a real check
   * ("type the list name to delete it"), not a speed bump.
   */
  confirmPhrase?: string;
  /** Rendered above the buttons — e.g. "This will affect 12,480 subscribers." */
  consequence?: string;
  /**
   * Where to send SCREEN-READER focus after the sheet closes.
   *
   * React Native restores nothing on dismiss: VoiceOver focus lands wherever
   * the platform puts it, which in practice is the top of the screen. A user
   * who was on the eleventh row of a list, opened a confirm and cancelled is
   * returned to the header and has to swipe back down to where they were —
   * so the cost of changing your mind scales with how far you had travelled.
   *
   * Pass the ref of the control that OPENED the sheet. Optional, and omitting
   * it is the pre-existing behaviour, so no call site is forced to change; the
   * refs that matter are the ones on long lists and long forms.
   */
  restoreFocusTo?: { current: unknown } | null;
}

type Resolver = (confirmed: boolean) => void;

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<Resolver | null>(null);

  // Read at settle time, not from `options`: `setOptions(null)` has already
  // run by the time the restore fires.
  const restoreTarget = useRef<{ current: unknown } | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolver.current;
    const target = restoreTarget.current;
    resolver.current = null;
    restoreTarget.current = null;
    setOptions(null);
    setTyped("");
    resolve?.(confirmed);
    // AFTER the modal has actually gone. Calling setAccessibilityFocus while
    // the modal is still on screen is a no-op — the target is not in the
    // active accessibility tree yet — so this waits for the dismissal to
    // commit. `focusOn` is itself a no-op for a null ref.
    if (target) setTimeout(() => focusOn(target), FOCUS_RESTORE_DELAY_MS);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    // A previously-open sheet resolves false rather than leaking a pending
    // promise — an unresolved await here would hang the calling flow forever.
    resolver.current?.(false);
    setTyped("");
    restoreTarget.current = next.restoreFocusTo ?? null;
    setOptions(next);
    haptics.warning();
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const value = useMemo<ConfirmContextValue>(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <ConfirmHost
        options={options}
        typed={typed}
        onTyped={setTyped}
        onSettle={settle}
      />
    </ConfirmContext.Provider>
  );
}

/**
 * `const confirm = useConfirm()` then `if (await confirm({...}))`.
 * Outside the provider it resolves `true`, so an isolated render or a test
 * that mounts a screen without the provider still exercises the action path
 * rather than silently doing nothing.
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  return ctx?.confirm ?? (() => Promise.resolve(true));
}

function ConfirmHost({
  options,
  typed,
  onTyped,
  onSettle,
}: {
  options: ConfirmOptions | null;
  typed: string;
  onTyped: (next: string) => void;
  onSettle: (confirmed: boolean) => void;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();

  if (!options) return null;

  const phraseRequired = Boolean(options.confirmPhrase);
  const phraseSatisfied = confirmPhraseSatisfied(options.confirmPhrase, typed);
  const confirmColor = options.destructive ? t.danger : t.accent;

  return (
    <ReducedMotionModal
      visible
      transparent
      animationType="fade"
      // Android hardware back and the iOS swipe both mean "cancel".
      onRequestClose={() => onSettle(false)}
      accessibilityViewIsModal
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          onPress={() => onSettle(false)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: t.overlay,
          }}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View
            accessibilityRole="alert"
            style={{
              backgroundColor: t.surfaceElevated,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              borderColor: t.border,
              borderWidth: 1,
              paddingHorizontal: 20,
              paddingTop: 20,
              paddingBottom: insets.bottom + 16,
              gap: 12,
            }}
          >
            {/* Grabber — signals "this sheet is dismissible" without copy. */}
            <View
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={{
                alignSelf: "center",
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: t.border,
                marginBottom: 4,
              }}
            />

            <Text
              accessibilityRole="header"
              {...typeCap("title")}
              style={{
                color: t.fg,
                fontFamily: FONT.display,
                ...typeStyle("title"),
                letterSpacing: -0.3,
              }}
            >
              {options.title}
            </Text>

            {options.message ? (
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.fgMuted,
                  fontFamily: FONT.regular,
                  ...typeStyle("callout"),
                }}
              >
                {options.message}
              </Text>
            ) : null}

            {options.consequence ? (
              <View
                style={{
                  backgroundColor: t.bgSubtle,
                  borderColor: options.destructive ? t.danger : t.border,
                  borderWidth: 1,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              >
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: options.destructive ? t.danger : t.fg,
                    fontFamily: FONT.medium,
                    ...typeStyle("bodySmall"),
                  }}
                >
                  {options.consequence}
                </Text>
              </View>
            ) : null}

            {phraseRequired ? (
              <View style={{ gap: 6 }}>
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgMuted,
                    fontFamily: FONT.regular,
                    ...typeStyle("bodySmall"),
                  }}
                >
                  Type{" "}
                  {/* Nested Text inherits the parent's cap, but stating it
                      keeps the phrase capped if this ever moves out. */}
                  <Text
                    {...typeCap("bodySmall")}
                    style={{ color: t.fg, fontFamily: FONT.semibold }}
                  >
                    {options.confirmPhrase}
                  </Text>{" "}
                  to confirm.
                </Text>
                <TextInput
                  value={typed}
                  onChangeText={onTyped}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  accessibilityLabel={`Type ${options.confirmPhrase} to confirm`}
                  placeholder={options.confirmPhrase ?? ""}
                  placeholderTextColor={t.fgSubtle}
                  // The return key does what the Confirm button does, and is
                  // inert until the phrase matches — the gate is the point.
                  {...keyboardChain({
                    onSubmit: () => {
                      haptics.impact();
                      onSettle(true);
                    },
                    disabled: !phraseSatisfied,
                  })}
                  // No `lineHeight` on a TextInput — see SearchField.
                  {...typeCap("body")}
                  style={{
                    color: t.fg,
                    fontFamily: FONT.regular,
                    fontSize: fontSizeFor("body"),
                    backgroundColor: t.bg,
                    borderColor: phraseSatisfied ? t.success : t.border,
                    borderWidth: 1,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    // 44pt minimum touch target.
                    minHeight: 44,
                  }}
                />
              </View>
            ) : null}

            <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
              <Pressable
                onPress={() => {
                  haptics.tap();
                  onSettle(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={options.cancelLabel ?? "Cancel"}
                style={{
                  flex: 1,
                  minHeight: 48,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: t.border,
                  backgroundColor: t.surface,
                }}
              >
                <Text
                  {...typeCap("body")}
                  style={{
                    color: t.fg,
                    fontFamily: FONT.semibold,
                    ...typeStyle("body"),
                  }}
                >
                  {options.cancelLabel ?? "Cancel"}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  if (!phraseSatisfied) return;
                  haptics.impact();
                  onSettle(true);
                }}
                disabled={!phraseSatisfied}
                accessibilityRole="button"
                accessibilityLabel={options.confirmLabel ?? "Confirm"}
                accessibilityState={{ disabled: !phraseSatisfied }}
                style={{
                  flex: 1,
                  minHeight: 48,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 12,
                  backgroundColor: confirmColor,
                  // Dim rather than hide, so the gate is visible and the user
                  // understands why the button hasn't fired.
                  opacity: phraseSatisfied ? 1 : 0.45,
                }}
              >
                <Text
                  {...typeCap("body")}
                  style={{
                    color: t.accentFg,
                    fontFamily: FONT.bold,
                    ...typeStyle("body"),
                  }}
                >
                  {options.confirmLabel ?? "Confirm"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </ReducedMotionModal>
  );
}
