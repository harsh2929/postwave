/**
 * AddDomainSheet — start the sending-domain setup from the phone.
 *
 * The empty state used to say "add a domain from the web admin". But the phone
 * is where the registrar app lives: add the domain here, read the generated
 * DNS records, share/paste them into the registrar, tap Re-verify — a complete
 * loop that never needs a laptop.
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
import {
  CUSTOM_DOMAIN_PURPOSES,
  normalizeDomainInput,
  type CustomDomainPurpose,
} from "@/hooks/useDomainOps";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardChain } from "@/lib/keyboardChain";

/** Loose hostname check; the server is still the authority. */
const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface AddDomainSheetProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (input: { domain: string; purpose: CustomDomainPurpose }) => void;
  submitting: boolean;
}

export function AddDomainSheet({
  visible,
  onClose,
  onSubmit,
  submitting,
}: AddDomainSheetProps) {
  const { t } = useTheme();
  const [domain, setDomain] = useState("");
  const [purpose, setPurpose] = useState<CustomDomainPurpose>("links");
  const [touched, setTouched] = useState(false);

  const normalized = normalizeDomainInput(domain);
  const valid = HOSTNAME_RE.test(normalized);
  const showError = touched && domain.trim() !== "" && !valid;

  function close() {
    setDomain("");
    setTouched(false);
    setPurpose("links");
    onClose();
  }

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Add a custom domain"
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
        Add a domain
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
        Moosewave generates the DNS records to publish. You can share them
        straight into your registrar app and come back to verify.
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
        Domain
      </Text>
      <TextInput
        value={domain}
        onChangeText={setDomain}
        onBlur={() => setTouched(true)}
        accessibilityLabel="Domain to add"
        placeholder="mail.example.com"
        placeholderTextColor={t.fgSubtle}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        // A one-field sheet: the return key IS the primary action, and stays
        // inert until the hostname parses.
        {...keyboardChain({
          onSubmit: () => onSubmit({ domain: normalized, purpose }),
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
          Enter a hostname like mail.example.com — no scheme or path.
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
        Purpose
      </Text>
      <SegmentedControl
        options={CUSTOM_DOMAIN_PURPOSES.map((p) => ({
          value: p.value,
          label: p.label,
        }))}
        value={purpose}
        onChange={setPurpose}
        accessibilityLabel="What this domain is for"
      />

      <Pressable
        onPress={() => {
          setTouched(true);
          if (!valid || submitting) return;
          onSubmit({ domain: normalized, purpose });
        }}
        disabled={!valid || submitting}
        accessibilityRole="button"
        accessibilityLabel="Add this domain"
        accessibilityState={{
          disabled: !valid || submitting,
          busy: submitting,
        }}
        style={{
          marginTop: 28,
          minHeight: 48,
          borderRadius: 12,
          backgroundColor: t.accent,
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
          {submitting ? "Adding…" : "Add domain"}
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
