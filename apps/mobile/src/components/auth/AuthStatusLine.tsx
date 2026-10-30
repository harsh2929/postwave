/**
 * AuthStatusLine — the one line between an auth form and its submit button.
 *
 * Three auth screens each carried their own copy of this: a danger-coloured
 * `accessibilityRole="alert"` for the failure, and a warning-coloured polite
 * line for "you're offline". They had drifted — one announced assertively, one
 * not at all — and the drift is invisible unless you are using a screen reader.
 *
 * The precedence is deliberate and is the whole reason it is one component: an
 * ERROR OUTRANKS THE OFFLINE NOTICE. Rendering both stacks two red-ish lines
 * that say different things about the same tap; rendering the offline notice
 * instead of a real server error hides the actual failure.
 */
import { Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuthStatusLineProps {
  /** Empty string means no error. */
  error: string;
  /** Rendered only when there is no error and the device is offline. */
  offline: boolean;
  offlineMessage: string;
  testID?: string | undefined;
}

export function AuthStatusLine({
  error,
  offline,
  offlineMessage,
  testID,
}: AuthStatusLineProps) {
  const { t } = useTheme();
  if (error) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.danger,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginTop: 4,
          marginBottom: 8,
        }}
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
        {...(testID ? { testID } : {})}
      >
        {error}
      </Text>
    );
  }
  if (!offline) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      {...typeCap("bodySmall")}
      style={{
        color: t.warning,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
        marginTop: 4,
        marginBottom: 8,
      }}
    >
      {offlineMessage}
    </Text>
  );
}
