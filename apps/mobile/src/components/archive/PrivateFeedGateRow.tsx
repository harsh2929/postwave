/**
 * PrivateFeedGateRow — the archive's answer about private subscriber feeds.
 *
 * There is no mint, no rotate, no revoke and no reveal here, and that is the
 * whole point: `lib/privateFeedBoundary.ts` carries the evidence, and this
 * renders it. An operator hunting for the control that revokes a leaked feed
 * URL gets "held back, and here is why, and it is held on desktop too" instead
 * of a screen that is silently missing a button.
 *
 * WHY A ROW AND NOT A BANNER. Desktop states this only when someone opens the
 * Private feeds workspace, not on the issue index. A permanent banner over
 * every archive session would be shouting a release fact at people who came to
 * read their newsletter list. The row is one line, admin-only, and opens the
 * full statement on press.
 *
 * NOTHING HERE IS A RETRY. The hold is a product boundary, not a failure, so
 * the sheet has no action but Close. Adding "Try again" would tell the reader
 * the sentence might stop being true if they pressed harder.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style` silently drops layout.
 */
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  PRIVATE_PODCAST_GATE_TITLE,
  PRIVATE_PODCAST_MOBILE_NOTE,
  PRIVATE_PODCAST_NO_CHANGE_NOTE,
  PRIVATE_PODCAST_RELEASE_CHECKLIST,
  PRIVATE_PODCAST_UNAVAILABLE_REASON,
  privateFeedGateVisible,
} from "@/lib/privateFeedBoundary";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function PrivateFeedGateRow({ canAdmin }: { canAdmin: boolean }) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const rowRef = useRef<View>(null);

  if (!privateFeedGateVisible({ canAdmin })) return null;

  return (
    <>
      <Pressable
        ref={rowRef}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel="Private subscriber feeds are review gated"
        accessibilityHint="Opens the release hold on minting, rotating and revoking podcast feed tokens"
        style={{
          minHeight: 44,
          justifyContent: "center",
          borderWidth: 1,
          borderColor: t.borderSubtle,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          marginBottom: 8,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Private subscriber feeds · Review gated
        </Text>
      </Pressable>

      <KeyboardFormSheet
        visible={open}
        onClose={() => setOpen(false)}
        accessibilityLabel="Private podcast feed release hold"
        returnFocusRef={rowRef}
      >
        <View style={{ gap: 12 }}>
          <Text
            accessibilityRole="header"
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.bold,
            }}
          >
            {PRIVATE_PODCAST_GATE_TITLE}
          </Text>

          <Body>{PRIVATE_PODCAST_UNAVAILABLE_REASON}</Body>

          <View
            accessibilityRole="list"
            accessibilityLabel="What release qualification still requires"
            style={{ gap: 6 }}
          >
            {PRIVATE_PODCAST_RELEASE_CHECKLIST.map((item) => (
              <Body key={item}>{"•  " + item}</Body>
            ))}
          </View>

          <Body>{PRIVATE_PODCAST_MOBILE_NOTE}</Body>
          <Body>{PRIVATE_PODCAST_NO_CHANGE_NOTE}</Body>

          <Pressable
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close the private feed release hold"
            style={{
              minHeight: 48,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("badge")}
              style={{
                color: t.accent,
                ...typeStyle("badge"),
                fontFamily: FONT.semibold,
              }}
            >
              Close
            </Text>
          </Pressable>
        </View>
      </KeyboardFormSheet>
    </>
  );
}

function Body({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
