/**
 * CliDeviceCodeField — the device code, in whichever of its two forms applies.
 *
 * Scanned from the QR the other device prints, the code is READ-ONLY and shown big, so
 * the user can compare it against the one on their terminal before approving —
 * that comparison is the only defence against approving someone else's grant.
 * Typed instead (another browser, desktop app, or a headless box over SSH), it
 * is an input. Both live here so the screen does not hold two layouts.
 */
import { Text, TextInput, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";

export function CliDeviceCodeField({
  scanned,
  code,
  valid,
  typedCode,
  onChangeTypedCode,
}: {
  /** True when the code arrived from a QR scan or universal link. */
  scanned: boolean;
  code: string;
  valid: boolean;
  typedCode: string;
  onChangeTypedCode: (value: string) => void;
}) {
  const { t } = useTheme();

  if (scanned) {
    return (
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 14,
          paddingVertical: 20,
          alignItems: "center",
        }}
      >
        {/* Spelled out character by character: "ABCD1234" read as a word is
            useless for the comparison this screen exists to enable. */}
        <Text
          {...typeCap("figure")}
          accessibilityLabel={
            valid
              ? `Device code ${code.split("").join(" ")}`
              : "That code is not valid"
          }
          style={{
            color: valid ? t.fg : t.danger,
            fontFamily: FONT.semibold,
            ...typeStyle("figure"),
            letterSpacing: 4,
          }}
        >
          {valid ? code : "Invalid code"}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        Code from the other device
      </Text>
      <TextInput
        value={typedCode}
        onChangeText={onChangeTypedCode}
        placeholder="ABCD-1234"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        maxLength={9}
        autoFocus
        accessibilityLabel="Device code, eight characters"
        accessibilityHint="Type the code shown on the device asking to sign in or connect."
        // The approve/deny decision is a deliberate two-button choice below,
        // so return dismisses rather than promising a submit it cannot make.
        {...keyboardDismiss()}
        // A fixed-width code field: it cannot reflow, so it takes the
        // `display` role's size and its tight ceiling rather than a
        // hand-picked multiplier.
        {...typeCap("display")}
        style={{
          backgroundColor: t.bgSubtle,
          borderColor: t.border,
          borderWidth: 1,
          color: t.fg,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 14,
          fontSize: fontSizeFor("display"),
          letterSpacing: 4,
          textAlign: "center",
          fontFamily: FONT.semibold,
        }}
      />
    </View>
  );
}
