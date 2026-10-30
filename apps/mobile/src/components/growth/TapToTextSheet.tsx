/**
 * TapToTextSheet — generate a tap-to-text block from the phone.
 *
 * Mobile parity for desktop's TapToTextBlockEditor
 * (apps/desktop/src/components/sms/TapToTextBlockEditor.tsx, hosted on the SMS
 * suppressions page). The artifact — an `sms:` link, its HTML button, and a QR
 * of the same link — is the most phone-native thing on that desktop page and
 * was the one piece of it a phone could not produce.
 *
 * NOTHING LEAVES THE DEVICE. There is no server route: generation is pure
 * string work in lib/tapToText.ts, the QR is rendered locally by
 * react-native-qrcode-svg (already a dependency for TOTP enrolment), and the
 * only ways out are the clipboard and the share sheet the operator invokes.
 * That is desktop's design, kept.
 *
 * THREE THINGS THE PHONE DOES BETTER, and why they are here:
 *  - the share sheet hands the link to a designer in one gesture, where
 *    desktop can only copy;
 *  - "Open in Messages" tests the link against a real SMS composer on the same
 *    device — desktop cannot verify its own output at all;
 *  - the QR is on a screen someone can hold up to another camera immediately.
 *
 * WHAT IT IS NOT is stated on the sheet, verbatim from desktop: generating,
 * copying, or scanning this asset does not configure a messaging provider,
 * enroll a person, transmit an inbound callback to Moosewave, or record or
 * prove consent. It is a creative asset, not a consent event — and the sheet
 * must never let the two read as the same act.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Linking, Pressable, Share, Text, TextInput, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import { KeyboardFormSheet, type ReturnFocusRef } from "@/components/KeyboardFormSheet";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  keyboardChain,
  keyboardDismiss,
  type KeyboardChainProps,
} from "@/lib/keyboardChain";
import {
  buildTapToTextBlock,
  tapToTextFieldError,
  tapToTextShareMessage,
  type TapToTextDraft,
} from "@/lib/tapToText";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const EMPTY_DRAFT: TapToTextDraft = { destination: "", keyword: "", label: "" };

export function TapToTextSheet({
  visible,
  onClose,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [draft, setDraft] = useState<TapToTextDraft>(EMPTY_DRAFT);
  // Destination → keyword → label is one chain. There is no submit: the block
  // regenerates on every keystroke, so the last field's return key only
  // dismisses ("go" would promise an action that does not exist).
  const keywordRef = useRef<TextInput>(null);
  const labelRef = useRef<TextInput>(null);

  const block = buildTapToTextBlock(draft);

  function close() {
    setDraft(EMPTY_DRAFT);
    onClose();
  }

  async function copy(text: string, what: string): Promise<void> {
    haptics.tap();
    try {
      await Clipboard.setStringAsync(text);
      toast({ kind: "success", message: `${what} copied` });
    } catch {
      toast({ kind: "error", message: `Couldn't copy the ${what.toLowerCase()}.` });
    }
  }

  async function share(): Promise<void> {
    if (!block) return;
    haptics.tap();
    try {
      await Share.share({ message: tapToTextShareMessage(block) });
    } catch {
      toast({ kind: "error", message: "Couldn't open the share sheet." });
    }
  }

  async function openInMessages(): Promise<void> {
    if (!block) return;
    haptics.tap();
    try {
      if (await Linking.canOpenURL(block.uri)) {
        await Linking.openURL(block.uri);
        return;
      }
    } catch {
      // canOpenURL throws for un-declared schemes; treat as unavailable.
    }
    toast({
      kind: "info",
      message: "No SMS app on this device could open the link.",
    });
  }

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Tap-to-text block"
      returnFocusRef={returnFocusRef}
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
        Tap-to-text block
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginBottom: 12,
        }}
      >
        Generate a local SMS link and QR creative asset. Opening it may hand off
        to a device SMS composer; the person still reviews and chooses whether to
        send, and device behaviour varies.
      </Text>
      <Text
        accessibilityRole="text"
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          backgroundColor: t.bgSubtle,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          marginBottom: 20,
        }}
      >
        Local creative tool only. Generating, copying, or scanning this asset
        does not configure a messaging provider, enroll a person, transmit an
        inbound callback to Moosewave, or record or prove consent.
      </Text>

      <DraftField
        label="Short code or number"
        accessibilityLabel="Short code or number"
        placeholder="12345"
        value={draft.destination}
        keyboardType="phone-pad"
        maxLength={32}
        {...keyboardChain({ next: keywordRef })}
        error={tapToTextFieldError("destination", draft.destination)}
        onChangeText={(destination) =>
          setDraft((current) => ({ ...current, destination }))
        }
      />
      <DraftField
        label="Keyword"
        accessibilityLabel="Keyword sent as the message body"
        placeholder="JOIN"
        value={draft.keyword}
        maxLength={80}
        inputRef={keywordRef}
        {...keyboardChain({ next: labelRef })}
        error={tapToTextFieldError("keyword", draft.keyword)}
        onChangeText={(keyword) => setDraft((current) => ({ ...current, keyword }))}
      />
      <DraftField
        label="Button label (optional)"
        accessibilityLabel="Button label shown in the creative"
        placeholder="Text KEYWORD to 12345"
        value={draft.label}
        // Sentence case, not the keyword field's SHOUT: this is the line a
        // reader sees on the finished creative ("Join our list"), and a
        // caps-locked keyboard silently ships it as JOIN OUR LIST.
        autoCapitalize="sentences"
        maxLength={240}
        inputRef={labelRef}
        {...keyboardDismiss()}
        error={tapToTextFieldError("label", draft.label)}
        onChangeText={(label) => setDraft((current) => ({ ...current, label }))}
      />

      {block ? (
        <View style={{ gap: 12 }}>
          <Readout label="Generated SMS link" value={block.uri} />
          <Readout label="Embed HTML" value={block.html} />
          <View
            accessible
            accessibilityLabel={`QR code for ${block.uri}`}
            style={{
              alignSelf: "center",
              // The quiet zone stays white in both themes or scanners lose it.
              backgroundColor: "#ffffff",
              padding: 12,
              borderRadius: 12,
            }}
          >
            <QRCode value={block.uri} size={168} />
          </View>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              textAlign: "center",
            }}
          >
            Local creative preview · no provider or consent effect
          </Text>
          <SheetAction label="Copy link" onPress={() => void copy(block.uri, "SMS link")} />
          <SheetAction
            label="Copy HTML"
            onPress={() => void copy(block.html, "HTML snippet")}
          />
          <SheetAction label="Share link" onPress={() => void share()} />
          <SheetAction label="Open in Messages" onPress={() => void openInMessages()} />
        </View>
      ) : (
        <Text
          {...typeCap("bodySmall")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            textAlign: "center",
            paddingVertical: 16,
          }}
        >
          Enter a valid destination and keyword to generate the link, the embed
          HTML, and a QR.
        </Text>
      )}

      <Pressable
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close the tap-to-text block"
        style={{
          marginTop: 20,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{ color: t.fgMuted, ...typeStyle("callout"), fontFamily: FONT.semibold }}
        >
          Done
        </Text>
      </Pressable>
    </KeyboardFormSheet>
  );
}

function DraftField({
  label,
  accessibilityLabel,
  placeholder,
  value,
  error,
  onChangeText,
  maxLength,
  keyboardType,
  autoCapitalize = "characters",
  inputRef,
  ...rest
}: {
  label: string;
  accessibilityLabel: string;
  placeholder: string;
  value: string;
  error: string | null;
  onChangeText: (next: string) => void;
  maxLength: number;
  keyboardType?: "phone-pad";
  autoCapitalize?: "characters" | "sentences";
  inputRef?: React.RefObject<TextInput | null>;
  // What the return key does. Spread from lib/keyboardChain at the call site
  // — the wrapper does not get to invent it, and the caller is the only one
  // that knows which field comes next.
} & KeyboardChainProps) {
  const { t } = useTheme();
  return (
    <View style={{ marginBottom: 16 }}>
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
        {label}
      </Text>
      <TextInput
        {...(inputRef ? { ref: inputRef } : {})}
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={accessibilityLabel}
        placeholder={placeholder}
        placeholderTextColor={t.fgSubtle}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        maxLength={maxLength}
        {...rest}
        {...(keyboardType ? { keyboardType } : {})}
        {...typeCap("body")}
        style={{
          backgroundColor: t.surface,
          borderColor: error ? t.danger : t.border,
          borderWidth: 1,
          color: t.fg,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 16,
          fontFamily: FONT.regular,
        }}
      />
      {error ? (
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
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View>
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
        {label}
      </Text>
      <Text
        selectable
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          backgroundColor: t.bgSubtle,
          borderRadius: 10,
          padding: 10,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function SheetAction({ label, onPress }: { label: string; onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        minHeight: 48,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.border,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{ color: t.accent, ...typeStyle("callout"), fontFamily: FONT.semibold }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
