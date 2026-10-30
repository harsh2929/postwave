/**
 * TotpSetupKeyBlock — the QR, the one-tap handoff, and the manual setup key.
 *
 * On a phone the QR is useless for the most common case: the authenticator app
 * is on the SAME phone, so there is no second camera to scan with. The
 * `otpauth://` handoff fixes that with zero new dependencies — 1Password,
 * Authy and Google Authenticator all register the scheme — and the manual key
 * stays as the fallback for anyone typing it into a desktop client.
 */
import { useEffect, useRef } from "react";
import { Alert, Linking, Pressable, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { copySecretToClipboard, type CancelSecretCopy } from "@/lib/secretClipboard";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function TotpSetupKeyBlock({ otpauthUri }: { otpauthUri: string }) {
  const { t } = useTheme();
  const secret = extractSecret(otpauthUri) ?? otpauthUri;
  const { toast } = useToast();
  const cancelCopyRef = useRef<CancelSecretCopy | null>(null);
  // Leaving the sheet with the key on the pasteboard is the worst case this
  // component can produce, so an unmount cancels the pending copy outright.
  useEffect(() => () => cancelCopyRef.current?.(), []);
  const copyKey = async () => {
    haptics.tap();
    cancelCopyRef.current?.();
    const result = await copySecretToClipboard(secret);
    cancelCopyRef.current = result.copied ? result.cancel : null;
    toast(
      result.copied
        ? { kind: "success", message: "Setup key copied. It clears from the clipboard in 90 seconds." }
        : { kind: "error", message: "Couldn't reach the clipboard. Scan the QR code or type the key instead." },
    );
  };

  async function openInAuthenticator(): Promise<void> {
    haptics.tap();
    try {
      if (await Linking.canOpenURL(otpauthUri)) {
        await Linking.openURL(otpauthUri);
        return;
      }
    } catch {
      // canOpenURL can throw for un-declared schemes; treat as unavailable.
    }
    Alert.alert(
      "No authenticator found",
      "Install an authenticator app, or type the setup key below into the one you already use.",
    );
  }

  return (
    <>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fgMuted,
          ...typeStyle("callout"),
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        Hand this to your authenticator app (1Password, Authy, Google
        Authenticator), then enter the 6-digit code below to confirm.
      </Text>

      <Pressable
        onPress={() => void openInAuthenticator()}
        accessibilityRole="button"
        accessibilityLabel="Open in your authenticator app"
        accessibilityHint="Sends the setup key straight to an authenticator on this phone."
        style={{
          paddingVertical: 12,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.accent,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          marginBottom: 16,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Open in authenticator app
        </Text>
      </Pressable>

      <View
        style={{
          alignItems: "center",
          backgroundColor: "#ffffff",
          borderRadius: 14,
          padding: 18,
          marginBottom: 16,
          alignSelf: "center",
        }}
        accessible
        accessibilityLabel="QR code for scanning from another device"
      >
        <QRCode
          value={otpauthUri}
          size={200}
          // White works in both themes; scanners demand it for reliability.
          backgroundColor="#ffffff"
          color="#000000"
        />
      </View>

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
        Or enter manually
      </Text>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          marginBottom: 20,
        }}
      >
        {/* Not `selectable`: a long-press copy goes to the pasteboard with no
            expiry and no way to cancel it. The button below is the ONLY copy
            path, and it clears itself the way the webhook secret does. */}
        <Text
          {...typeCap("mono")}
          style={{ color: t.fg, ...typeStyle("mono"), fontFamily: "Menlo" }}
          numberOfLines={3}
          accessibilityLabel="Setup key"
          accessibilityHint="Use Copy setup key to place it on the clipboard for ninety seconds"
        >
          {secret}
        </Text>
        <Pressable
          onPress={() => void copyKey()}
          accessibilityRole="button"
          accessibilityLabel="Copy setup key"
          hitSlop={8}
          style={{ marginTop: 10, minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{ color: t.accent, fontFamily: FONT.semibold, ...typeStyle("control") }}
          >
            Copy setup key
          </Text>
        </Pressable>
      </View>
    </>
  );
}

/**
 * Extract the base32 secret from an otpauth:// URI for manual-entry fallback.
 * otpauth://totp/Moosewave:user@x.com?secret=ABCD…&issuer=Moosewave
 */
export function extractSecret(uri: string): string | null {
  const m = uri.match(/[?&]secret=([^&]+)/i);
  return m?.[1] ?? null;
}
