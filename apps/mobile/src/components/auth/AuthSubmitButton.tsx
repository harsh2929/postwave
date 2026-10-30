/**
 * AuthSubmitButton — the single filled primary action on an auth screen.
 *
 * Every auth screen had its own copy of this Pressable: the same 44pt floor,
 * the same `opacity: disabled ? 0.5 : 1`, the same swap of the label for an
 * ActivityIndicator. Copies drift — and the ones that drifted first were the
 * accessibility props, because they are the part nobody sees. Here `busy` and
 * `disabled` always reach `accessibilityState` together, so a screen reader
 * never announces an enabled button that will ignore the tap.
 *
 * NativeWind v4: a static style object only. `style={({pressed}) => …}` on a
 * Pressable silently drops layout. Press state therefore lives in React state:
 * an immediate opacity/background change on iOS, plus a bounded native ripple
 * on Android. No timing primitive is involved, so Reduce Motion stays honored.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuthSubmitButtonProps {
  label: string;
  onPress: () => void;
  /** Blocks the tap AND is announced. Defaults to false. */
  disabled?: boolean | undefined;
  /** Renders the spinner in place of the label and announces busy. */
  busy?: boolean | undefined;
  /** Override when the visible label omits state, e.g. a countdown. */
  accessibilityLabel?: string | undefined;
  testID?: string | undefined;
}

export function AuthSubmitButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  accessibilityLabel,
  testID,
}: AuthSubmitButtonProps) {
  const { t } = useTheme();
  const blocked = disabled || busy;
  const [pressed, setPressed] = useState(false);

  // A request can flip `busy` before the finger lifts. Clear the transient
  // state immediately so re-enabling later cannot resurrect a stale press.
  useEffect(() => {
    if (blocked) setPressed(false);
  }, [blocked]);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => {
        if (!blocked) setPressed(true);
      }}
      onPressOut={() => setPressed(false)}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: blocked, busy }}
      android_ripple={{ color: t.accentFg, borderless: false }}
      style={{
        marginTop: 4,
        paddingVertical: 14,
        borderRadius: 12,
        backgroundColor: pressed && !blocked ? t.accentDim : t.accent,
        alignItems: "center",
        justifyContent: "center",
        minHeight: 44,
        overflow: "hidden",
        opacity: blocked ? 0.5 : pressed ? 0.86 : 1,
      }}
      {...(testID ? { testID } : {})}
    >
      {busy ? (
        <ActivityIndicator color={t.accentFg} />
      ) : (
        <Text
          {...typeCap("body")}
          style={{
            color: t.accentFg,
            fontWeight: "700",
            fontFamily: FONT.bold,
            ...typeStyle("body"),
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
