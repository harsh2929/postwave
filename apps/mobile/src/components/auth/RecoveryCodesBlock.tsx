/**
 * RecoveryCodesBlock — the eight one-time account-recovery secrets, plus the
 * means to actually save them.
 *
 * The enrollment sheet demanded the user tick "I've saved my recovery codes"
 * before the verification field became editable, and then gave them no way to
 * save: the codes were eight `selectable` <Text> nodes, so "saving" meant
 * long-press → select → drag handles → Copy, eight times, inside a modal. The
 * checkbox was a lie. The server issues these exactly once
 * (`GenerateRecoveryCodes` runs inside TOTPEnroll and there is no regenerate
 * route), so there is no second chance.
 *
 * `Share` is used rather than a clipboard write because expo-clipboard is not
 * a dependency of this app, and Share is strictly better here anyway: it
 * offers Files, Notes and a password manager as destinations, whereas the
 * clipboard is the one place these should NOT sit.
 *
 * `onSaved` fires only after a share sheet is actually dismissed with an
 * action, so the attestation checkbox above can gate on something real.
 */
import { useState } from "react";
import { Pressable, Share, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const SAVED_LABEL_MS = 2000;

export function RecoveryCodesBlock({
  codes,
  workspaceLabel,
  onSaved,
}: {
  codes: readonly string[];
  workspaceLabel?: string | undefined;
  onSaved: () => void;
}) {
  const { t } = useTheme();
  const [justSaved, setJustSaved] = useState(false);

  async function share(): Promise<void> {
    try {
      const header = workspaceLabel
        ? `Moosewave recovery codes — ${workspaceLabel}`
        : "Moosewave recovery codes";
      const result = await Share.share({
        title: header,
        message: `${header}\n\n${codes.join("\n")}\n\nEach code works once. Store them somewhere only you can reach.`,
      });
      if (result.action === Share.dismissedAction) return;
      haptics.success();
      setJustSaved(true);
      onSaved();
      setTimeout(() => setJustSaved(false), SAVED_LABEL_MS);
    } catch {
      // The device cannot present a share sheet at all. The codes are still
      // on screen and still selectable, so unblock the attestation rather
      // than trapping the user in an enrollment they cannot finish — a hard
      // block here would be strictly worse than a soft one.
      onSaved();
    }
  }

  return (
    <>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Recovery codes
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginBottom: 8,
          fontFamily: FONT.regular,
        }}
      >
        {`These ${codes.length} codes are shown once and each works once. Save them somewhere only you can reach — a password manager, not your camera roll.`}
      </Text>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          marginBottom: 10,
        }}
        accessible
        accessibilityLabel={`${codes.length} recovery codes: ${codes.join(", ")}`}
      >
        {codes.map((code) => (
          <Text
            key={code}
            selectable
            {...typeCap("mono")}
            style={{
              color: t.fg,
              ...typeStyle("mono"),
              fontFamily: "Menlo",
              letterSpacing: 1,
              paddingVertical: 2,
            }}
          >
            {code}
          </Text>
        ))}
      </View>
      <Pressable
        onPress={() => void share()}
        accessibilityRole="button"
        accessibilityLabel="Save recovery codes"
        accessibilityHint="Opens the share sheet so you can store the codes in a password manager or file."
        style={{
          paddingVertical: 12,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: justSaved ? t.success : t.accent,
          backgroundColor: justSaved ? `${t.success}1a` : "transparent",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          marginBottom: 12,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: justSaved ? t.success : t.accent,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {justSaved ? "Saved ✓" : "Save recovery codes…"}
        </Text>
      </Pressable>
    </>
  );
}
