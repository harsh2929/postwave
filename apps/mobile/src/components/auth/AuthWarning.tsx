/**
 * AuthWarning — the strip that reports a pending secure-cleanup failure on the
 * sign-in screen, with the retry that resolves it.
 *
 * Extracted from sign-in.tsx (which is under a hard line budget) so the screen
 * can stay a state → view switch. The retry is the only way out of a
 * `localCleanupPending` state: until the prior session's SecureStore artifacts
 * are cleared, signing in again would inherit them.
 *
 * NOT EVERY WARNING HAS A RETRY. A sign-out whose local cleanup succeeded but
 * whose SERVER revocation did not sets an authWarning with
 * `localCleanupPending: false` (store/authSignIn.ts cancelAuthSession), so the
 * strip renders with no button on it at all — read it, understand it, and then
 * live with it sitting above the form for the rest of the process. Those get a
 * dismiss instead. An ACTIONABLE warning deliberately does not: hiding it would
 * hide the only route out of the state it describes.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AuthWarning({
  message,
  busy,
  showRetry,
  onRetry,
  onDismiss,
}: {
  message: string;
  busy: boolean;
  showRetry: boolean;
  onRetry: () => void;
  /** Offered only when there is no retry — see the module header. */
  onDismiss?: (() => void) | undefined;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.warning,
        backgroundColor: `${t.warning}14`,
        borderRadius: 12,
        padding: 12,
        marginBottom: 16,
      }}
    >
      <Text
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {message}
      </Text>
      {showRetry ? (
        <Pressable
          onPress={onRetry}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Retry secure local cleanup"
          accessibilityState={{ disabled: busy }}
          style={{
            marginTop: 10,
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 4,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.accent,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Retry secure cleanup
          </Text>
        </Pressable>
      ) : onDismiss ? (
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss this warning"
          style={{
            marginTop: 10,
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 4,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.accent,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Dismiss
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
