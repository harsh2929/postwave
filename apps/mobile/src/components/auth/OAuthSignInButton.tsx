/**
 * OAuthSignInButton — the "Continue with Google" affordance, plus the divider
 * that separates it from the credential form.
 *
 * Presentation only: the screen owns the round-trip (hooks/useGoogleSignIn).
 *
 * DESIGN NOTES THAT ARE NOT DECORATION.
 *  - It is an OUTLINE button, not a second filled one. Two filled buttons of
 *    equal weight on a sign-in screen make the user choose between two primary
 *    actions; the credential form stays primary and this is the alternative.
 *  - The "G" mark is drawn as text inside a bordered square rather than
 *    shipped as an image. Google's brand guidelines require their exact asset,
 *    and an approximate SVG would be a worse violation than a neutral mark; a
 *    letterform makes no claim to be their logo. It is `importantForAccessibility
 *    ="no"`/hidden so VoiceOver reads the button once, not "G, Continue with
 *    Google".
 *  - `minHeight: 48` (not 44) because the row also has to survive the largest
 *    Dynamic Type step without the label clipping against the mark.
 *
 * NativeWind v4: static style objects only — the function form silently drops
 * layout on a Pressable. Press state is an immediate state-driven paint change
 * on iOS and a bounded native ripple on Android; it never schedules motion.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface OAuthSignInButtonProps {
  onPress: () => void;
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
  testID?: string | undefined;
}

export function OAuthSignInButton({
  onPress,
  busy = false,
  disabled = false,
  testID,
}: OAuthSignInButtonProps) {
  const { t } = useTheme();
  const blocked = disabled || busy;
  const [pressed, setPressed] = useState(false);

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
      accessibilityLabel="Continue with Google"
      accessibilityHint="Opens Google in a secure browser to sign in"
      accessibilityState={{ disabled: blocked, busy }}
      android_ripple={{ color: t.accentSubtle, borderless: false }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        minHeight: 48,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: pressed && !blocked ? t.accent : t.border,
        backgroundColor: pressed && !blocked ? t.accentSubtle : t.surface,
        overflow: "hidden",
        opacity: blocked ? 0.6 : pressed ? 0.82 : 1,
      }}
      {...(testID ? { testID } : {})}
    >
      {busy ? (
        <ActivityIndicator color={t.fgMuted} />
      ) : (
        <>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              width: 22,
              height: 22,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: t.borderSubtle,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("label")}
              style={{
                color: t.fg,
                ...typeStyle("label"),
                fontWeight: "700",
                fontFamily: FONT.bold,
              }}
            >
              G
            </Text>
          </View>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Continue with Google
          </Text>
        </>
      )}
    </Pressable>
  );
}

/**
 * The "or" rule. Split out so the button can be placed without it (the sign-up
 * screen may want a different order) and so the screen file stays a switch.
 */
export function AuthMethodDivider({ label = "or" }: { label?: string }) {
  const { t } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginVertical: 14,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: t.borderSubtle }} />
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: t.borderSubtle }} />
    </View>
  );
}
