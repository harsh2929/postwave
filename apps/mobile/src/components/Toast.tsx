/**
 * Toast — transient, non-blocking confirmation with an optional UNDO.
 *
 * Why: this app had 117 `Alert.alert` call sites and no other feedback
 * channel. `Alert` is a modal — it steals focus, blocks the whole UI, and
 * demands a tap to dismiss. That is the right weight for "are you sure you
 * want to delete this", and completely the wrong weight for "Saved." Using it
 * for both means every successful save costs the user an interaction, and the
 * genuinely dangerous prompts stop feeling dangerous because they look
 * identical to the harmless ones.
 *
 * The split this component establishes:
 *   - `Alert` / `ConfirmSheet`  → BEFORE a consequential action ("are you sure?")
 *   - `toast()`                 → AFTER any action ("done", "failed, retry?")
 *
 * UNDO is the feature that makes the split safe. A destructive action with a
 * 6-second undo window is *better* UX than a confirm dialog: the common case
 * (you meant it) costs zero taps, and the rare case (you misfired) is one tap
 * to reverse. Where a mutation is reversible, prefer `toast({action: undo})`
 * over a pre-confirm entirely.
 *
 * Mounted once in `app/_layout.tsx` above the navigator.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { haptics } from "@/lib/haptics";
import {
  enqueueFeedback,
  feedbackInterrupts,
  isRedundantFeedback,
  toastAnnouncement,
  toastDurationMs,
} from "@/lib/feedbackPolicy";
import { FONT } from "@/lib/fonts";
import { timing, useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface ToastOptions {
  message: string;
  kind?: ToastKind;
  /** Optional inline action — most usefully an "Undo". */
  action?: ToastAction;
  /**
   * Visible lifetime in ms. Defaults scale with content: a toast carrying an
   * action gets longer, because the user has to read AND decide.
   */
  durationMs?: number;
}

interface ToastEntry extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions | string) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<ToastEntry | null>(null);
  // Toasts that arrived while one was already on screen. This host used to
  // REPLACE — so a bulk action producing two confirmations threw one away,
  // and if the discarded one carried an undo, the only path back from a
  // committed write vanished with it. Eviction policy lives in feedbackPolicy.
  const [pending, setPending] = useState<readonly ToastEntry[]>([]);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `entry` synchronously. `toast()` has to know what is on screen
  // *right now* to decide queue-vs-interrupt, and reading that through a
  // state updater would mean running side effects inside one.
  const visible = useRef<ToastEntry | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /** Show one entry: announce it, arm its expiry. */
  const present = useCallback(
    (next: ToastEntry) => {
      clearTimer();
      visible.current = next;
      setEntry(next);
      // VoiceOver does not reliably announce a newly-mounted live region on
      // iOS, so announce explicitly. Without this the toast is invisible to
      // a screen-reader user — and an *undo* they cannot hear about is worse
      // than no undo at all.
      AccessibilityInfo.announceForAccessibility(toastAnnouncement(next));
      timer.current = setTimeout(() => {
        timer.current = null;
        // Clearing the screen is what advances the queue (see the drain
        // effect), so a queued undo still gets its own full window.
        if (visible.current?.id === next.id) visible.current = null;
        setEntry((current) => (current?.id === next.id ? null : current));
      }, toastDurationMs(next));
    },
    [clearTimer],
  );

  // Whenever nothing is showing, pull the next waiting entry. Driven by an
  // effect (not by the timeout) so a manual dismiss and an expiry advance the
  // queue through exactly the same path.
  useEffect(() => {
    if (entry || pending.length === 0) return;
    const [next, ...rest] = pending;
    setPending(rest);
    if (next) present(next);
  }, [entry, pending, present]);

  const dismiss = useCallback(() => {
    clearTimer();
    visible.current = null;
    setEntry(null);
  }, [clearTimer]);

  const toast = useCallback(
    (options: ToastOptions | string) => {
      const opts: ToastOptions =
        typeof options === "string" ? { message: options } : options;
      const kind = opts.kind ?? "info";
      const current = visible.current;

      // The identical message is already on screen and neither carries an
      // action: the user has been told. Drop it before the haptic too — a
      // bulk failure buzzing the device ten times is the same bug in another
      // channel.
      if (current && isRedundantFeedback(current, { ...opts, kind })) return;

      // Physical feedback matches the semantic weight. Success/error get the
      // notification patterns; info/warning stay silent so routine saves in a
      // tight loop don't buzz the device continuously.
      if (kind === "success") haptics.success();
      else if (kind === "error") haptics.error();

      seq.current += 1;
      const next: ToastEntry = { ...opts, kind, id: seq.current };

      if (!current) {
        present(next);
        return;
      }
      if (feedbackInterrupts(current.kind, kind)) {
        // An error takes the screen now; the displaced toast goes back to the
        // FRONT of the queue rather than being lost.
        setPending((queue) => [current, ...queue]);
        present(next);
        return;
      }
      setPending((queue) => enqueueFeedback(queue, next));
    },
    [present],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const value = useMemo<ToastContextValue>(
    () => ({ toast, dismiss }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastHost entry={entry} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * Returns `{ toast, dismiss }`. Safe to call outside the provider (tests,
 * isolated component renders) — it degrades to a no-op rather than throwing,
 * because a missing toast must never take down a screen.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  return (
    ctx ?? {
      toast: () => undefined,
      dismiss: () => undefined,
    }
  );
}

function ToastHost({
  entry,
  onDismiss,
}: {
  entry: ToastEntry | null;
  onDismiss: () => void;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { reduceMotion } = useMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = timing(entry ? 1 : 0, entry ? "enter" : "exit", reduceMotion);
  }, [entry, reduceMotion, progress]);

  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    // Rise from below. Small travel (14pt) — a toast that flies across the
    // screen draws more attention than its content deserves.
    transform: [{ translateY: (1 - progress.value) * 14 }],
  }));

  if (!entry) return null;

  const accent =
    entry.kind === "success"
      ? t.success
      : entry.kind === "error"
        ? t.danger
        : entry.kind === "warning"
          ? t.warning
          : t.info;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        {
          position: "absolute",
          left: 12,
          right: 12,
          // Sits above the tab bar (~49pt) plus the home indicator inset.
          bottom: insets.bottom + 60,
        },
        animated,
      ]}
    >
      <View
        // `alert` for errors so assistive tech interrupts with them; plain
        // text otherwise, paired with the polite live region below so routine
        // confirmations queue behind whatever the user is already hearing.
        accessibilityRole={entry.kind === "error" ? "alert" : "text"}
        accessibilityLiveRegion={entry.kind === "error" ? "assertive" : "polite"}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: t.surfaceElevated,
          borderColor: t.border,
          borderWidth: 1,
          // Logical edges. The accent bar marks the READING-ORDER start of the
          // toast; on an RTL locale (AndroidManifest declares supportsRtl) the
          // row mirrors, so a physical `borderLeftWidth` would leave the stripe
          // trailing the text and the 14pt gutter on the wrong side.
          borderStartWidth: 3,
          borderStartColor: accent,
          borderRadius: 12,
          paddingVertical: 12,
          paddingStart: 14,
          paddingEnd: entry.action ? 6 : 14,
          // A toast floats over content, so it needs real separation.
          shadowColor: "#000",
          shadowOpacity: 0.22,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 6 },
          elevation: 6,
        }}
      >
        <Text
          numberOfLines={3}
          {...typeCap("callout")}
          style={{
            flex: 1,
            color: t.fg,
            fontFamily: FONT.medium,
            ...typeStyle("callout"),
          }}
        >
          {entry.message}
        </Text>

        {entry.action ? (
          <Pressable
            onPress={() => {
              haptics.tap();
              const run = entry.action?.onPress;
              onDismiss();
              run?.();
            }}
            accessibilityRole="button"
            accessibilityLabel={entry.action.label}
            hitSlop={8}
            style={{
              minHeight: 44,
              minWidth: 44,
              paddingHorizontal: 12,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                fontFamily: FONT.bold,
                ...typeStyle("callout"),
              }}
            >
              {entry.action.label}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={12}
            style={{
              minWidth: 24,
              minHeight: 24,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Decorative glyph standing in for an icon — see SearchField. */}
            <Text
              allowFontScaling={false}
              style={{ color: t.fgSubtle, fontFamily: FONT.medium, fontSize: 17 }}
            >
              ×
            </Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}
