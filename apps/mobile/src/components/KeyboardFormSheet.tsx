/**
 * KeyboardFormSheet — the shared page-sheet chrome for this app's forms.
 *
 * `accessibilityViewIsModal` on the SafeAreaView is what stops VoiceOver
 * wandering into the screen underneath while the sheet is up.
 *
 * RETURN FOCUS. When a sheet closes, iOS hands screen-reader focus back to
 * wherever UIKit chooses — usually the top of the presenting screen, not the
 * control the operator pressed to get here. On a screen whose actions are a
 * row of eight buttons that means re-navigating the whole row after every
 * dismissal. Pass `returnFocusRef` (the invoking control) and focus is put
 * back where it was. It is best-effort by construction: `focusOn` swallows a
 * missing node.
 *
 * WHEN the focus is moved is the part that decides whether this works at all.
 * `setAccessibilityFocus` is silently ignored while the sheet is still on
 * screen, and a page-sheet slides out over roughly a third of a second — far
 * longer than the single animation frame a `visible → false` effect can wait
 * for. iOS answers this exactly: `Modal.onDismiss` fires once the dismissal
 * has finished, which is the first moment the target is focusable. Android has
 * no such callback, so it keeps the frame-delayed effect, which is enough
 * there because TalkBack re-resolves focus after the window closes rather than
 * dropping the request.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { focusOn } from "@/lib/a11y";
import { useTheme } from "@/lib/theme";

/**
 * The control a sheet should hand screen-reader focus back to on dismiss.
 *
 * Deliberately structural (`{ current: unknown }`) rather than
 * `RefObject<View>`: a sheet does not care what kind of node opened it, and
 * every intermediate component that merely forwards this prop would otherwise
 * need a `react-native` type import to say so. Exported so those forwarders
 * name the same type instead of re-declaring it eight times.
 */
export type ReturnFocusRef = { current: unknown };

export function KeyboardFormSheet({
  visible,
  onClose,
  children,
  contentContainerStyle,
  accessibilityLabel = "Form sheet",
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** The control that opened this sheet; focus returns to it on dismiss. */
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const restore = useCallback(() => {
    if (returnFocusRef) focusOn(returnFocusRef);
  }, [returnFocusRef]);
  const wasVisible = useRef(false);
  useEffect(() => {
    const closing = wasVisible.current && !visible;
    wasVisible.current = visible;
    // iOS restores from `onDismiss` below — running here too would fire the
    // request into a sheet that is still sliding away, where it is dropped.
    if (!closing || !returnFocusRef || Platform.OS === "ios") return;
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [visible, returnFocusRef, restore]);
  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      // iOS-only; a no-op elsewhere, so it is passed unconditionally.
      onDismiss={restore}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel={accessibilityLabel}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={[
              { padding: 20, paddingBottom: 32 },
              contentContainerStyle,
            ]}
          >
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
