/**
 * AddSuppressionSheet — block an address from the phone.
 *
 * The counterpart to un-suppress. A complaint escalation, an abusive
 * recipient or a legal request all produce "block this address now", and "now"
 * is often not at a desk. Bulk/CSV import correctly stays on desktop; a single
 * address is a two-field form.
 *
 * POST /api/v1/deliverability/suppressions is admin-scoped and writes a
 * suppression_audit row automatically, so the reason picked here shows up on
 * the detail screen's timeline.
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
import {
  isLikelyEmail,
  MANUAL_ADD_REASONS,
  type ManualAddReason,
} from "@/lib/suppressionSearch";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardChain } from "@/lib/keyboardChain";

export interface AddSuppressionSheetProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (input: { email: string; reason: ManualAddReason }) => void;
  submitting: boolean;
}

export function AddSuppressionSheet({
  visible,
  onClose,
  onSubmit,
  submitting,
}: AddSuppressionSheetProps) {
  const { t } = useTheme();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<ManualAddReason>("list_manual");
  const [touched, setTouched] = useState(false);

  const valid = isLikelyEmail(email);
  const showError = touched && email.trim() !== "" && !valid;

  function close() {
    setEmail("");
    setTouched(false);
    setReason("list_manual");
    onClose();
  }

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Add a suppression"
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
        Suppress an address
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginBottom: 20,
        }}
      >
        Moosewave stops sending to this address immediately. The reason is
        recorded in the audit trail.
      </Text>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.6,
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        Email address
      </Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        onBlur={() => setTouched(true)}
        accessibilityLabel="Email address to suppress"
        placeholder="person@example.com"
        placeholderTextColor={t.fgSubtle}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        {...keyboardChain({
          onSubmit: () => onSubmit({ email: email.trim().toLowerCase(), reason }),
          disabled: !valid || submitting,
        })}
        style={{
          backgroundColor: t.surface,
          borderColor: showError ? t.danger : t.border,
          borderWidth: 1,
          color: t.fg,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 16,
          fontFamily: FONT.regular,
        }}
        // 16pt is deliberate on an input (a smaller field reads as disabled),
        // and no explicit lineHeight — it mis-centres the caret on Android.
        // The ceiling still comes from the scale so the field cannot outgrow
        // the sheet it sits in.
        {...typeCap("body")}
      />
      {showError ? (
        <Text
          {...typeCap("label")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.danger,
            ...typeStyle("label"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          Enter a full email address.
        </Text>
      ) : null}

      <View style={{ height: 20 }} />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.6,
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        Reason
      </Text>
      <SegmentedControl
        options={MANUAL_ADD_REASONS.map((r) => ({
          value: r.value as ManualAddReason,
          label: r.label,
        }))}
        value={reason}
        onChange={setReason}
        accessibilityLabel="Suppression reason"
        scrollable
      />

      <Pressable
        onPress={() => {
          setTouched(true);
          if (!valid || submitting) return;
          onSubmit({ email: email.trim().toLowerCase(), reason });
        }}
        disabled={!valid || submitting}
        accessibilityRole="button"
        accessibilityLabel="Suppress this address"
        accessibilityState={{
          disabled: !valid || submitting,
          busy: submitting,
        }}
        style={{
          marginTop: 28,
          minHeight: 48,
          borderRadius: 12,
          backgroundColor: t.danger,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: !valid || submitting ? 0.5 : 1,
        }}
      >
        {submitting ? (
          <ActivityIndicator size="small" color={t.accentFg} />
        ) : null}
        <Text
          {...typeCap("body")}
          style={{
            color: t.accentFg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          {submitting ? "Suppressing…" : "Suppress address"}
        </Text>
      </Pressable>
      <Pressable
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={{
          marginTop: 10,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fgMuted,
            ...typeStyle("callout"),
            fontFamily: FONT.medium,
          }}
        >
          Cancel
        </Text>
      </Pressable>
    </KeyboardFormSheet>
  );
}
