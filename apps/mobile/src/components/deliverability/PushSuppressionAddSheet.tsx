/**
 * PushSuppressionAddSheet — suppress one customer device token by paste.
 *
 * Desktop's add-by-token verb (PushSuppressions.tsx), translated: nobody
 * types a 20–4096-byte token on a phone keyboard, but pasting one out of a
 * support ticket or crash report is exactly the 2am shape. The write creates
 * a REVERSIBLE manual dashboard authority (the server admits no other reason
 * from this surface), so submission is direct — the undo is the roster's own
 * Remove swipe — and no consent claim is made.
 *
 * Validation mirrors the handler's byte rules (lib/pushSuppressionAdd.ts) so
 * the operator hears about a truncated paste before the request, not after.
 * Only ever mounted inside the exact-admin panel.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { pushTokenProblem } from "@/lib/pushSuppressionAdd";
import type { PushPlatform } from "@/lib/pushSuppressions";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const PLATFORM_OPTIONS: { value: PushPlatform; label: string }[] = [
  { value: "apns", label: "APNs" },
  { value: "fcm", label: "FCM" },
  { value: "web", label: "Web" },
];

export function PushSuppressionAddSheet({
  visible,
  submitting,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: { deviceToken: string; platform: PushPlatform }) => void;
}) {
  const { t } = useTheme();
  const [token, setToken] = useState("");
  const [platform, setPlatform] = useState<PushPlatform>("apns");
  const [touched, setTouched] = useState(false);

  const trimmed = token.trim();
  const problem = trimmed ? pushTokenProblem(trimmed) : "A token is required.";
  const showProblem = touched && trimmed !== "" && problem !== null;

  function close() {
    if (submitting) return;
    setToken("");
    setTouched(false);
    setPlatform("apns");
    onClose();
  }

  const submit = () => {
    setTouched(true);
    if (problem || submitting) return;
    haptics.tap();
    onSubmit({ deviceToken: trimmed, platform });
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Suppress a device token"
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.bold,
          marginBottom: 4,
        }}
      >
        Suppress a device token
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginBottom: 16,
        }}
      >
        Adds a reversible manual hold for one customer device. It changes
        future eligibility under this stored authority only — it does not
        record consent or prove delivery state.
      </Text>
      <SegmentedControl
        options={PLATFORM_OPTIONS}
        value={platform}
        onChange={(next) => setPlatform(next as PushPlatform)}
        accessibilityLabel="Device platform"
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.6,
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          marginTop: 14,
          marginBottom: 4,
        }}
      >
        Device token
      </Text>
      <TextInput
        value={token}
        onChangeText={setToken}
        onBlur={() => setTouched(true)}
        accessibilityLabel="Device token to suppress"
        placeholder="Paste the full token…"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        numberOfLines={3}
        style={{
          backgroundColor: t.surface,
          borderColor: showProblem ? t.danger : t.border,
          borderWidth: 1,
          color: t.fg,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 16,
          fontFamily: FONT.regular,
          minHeight: 84,
          textAlignVertical: "top",
        }}
        {...typeCap("body")}
      />
      {showProblem ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            fontFamily: FONT.medium,
            marginTop: 6,
          }}
        >
          {problem}
        </Text>
      ) : null}
      <Pressable
        onPress={submit}
        // Not disabled on a bad token: the press is what SURFACES the byte
        // rule's sentence (a disabled button with no visible reason is a
        // dead end). Only an in-flight submit disarms it.
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel="Suppress this device token"
        accessibilityState={{
          disabled: submitting,
          busy: submitting,
        }}
        style={{
          marginTop: 18,
          minHeight: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          backgroundColor: t.accent,
          opacity: submitting || problem ? 0.6 : 1,
        }}
      >
        {submitting ? (
          <ActivityIndicator size="small" color={t.accentFg} />
        ) : null}
        <Text
          {...typeCap("control")}
          style={{
            color: t.accentFg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {submitting ? "Suppressing…" : "Suppress device"}
        </Text>
      </Pressable>
      <View style={{ height: 8 }} />
    </KeyboardFormSheet>
  );
}
