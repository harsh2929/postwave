/**
 * ContextualHintButton — the mobile renderer for @postwave/onboarding-schema's
 * CONTEXTUAL_HINTS, the cross-platform "why does this field exist?" copy.
 *
 * Desktop renders each hint as HintPopover beside its field. A phone has no
 * hover and no room for a popover next to a 44pt control, so this follows
 * SettingsHelpSheet's pattern instead: a small labelled button that opens a
 * sheet with the same title, body and learn-more link the desktop shows. The
 * COPY is the shared contract's, verbatim — this component adds no words.
 *
 * Unknown keys render nothing, as on desktop, so a hint the schema drops
 * cannot leave a dangling "?" behind. lib/contextualHints.test.ts is what
 * keeps the set of mounted keys honest.
 *
 * Placement rule: never inside an `accessible` group. BestTimeScheduleCard's
 * header is one switch to VoiceOver, and a button nested in it would be
 * swallowed; the hint sits beside the group there.
 */
import { useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { contextualHint } from "@/lib/contextualHints";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { safeDocsUrl } from "@/lib/integrationHealth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ContextualHintButton({
  hintKey,
  compact = false,
}: {
  hintKey: string;
  /** Icon-only trigger for dense rows; the accessible name is the hint's title either way. */
  compact?: boolean;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const hint = contextualHint(hintKey);
  if (!hint) return null;
  const learnMore = safeDocsUrl(hint.learnMoreUrl);

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={hint.title}
        accessibilityHint="Opens a short explanation"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={{
          minWidth: compact ? 28 : 44,
          minHeight: compact ? 28 : 44,
          paddingHorizontal: compact ? 4 : 8,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.accent,
            fontFamily: FONT.semibold,
            ...typeStyle("caption"),
          }}
        >
          {compact ? "?" : "Why?"}
        </Text>
      </Pressable>

      <KeyboardFormSheet
        visible={open}
        onClose={() => setOpen(false)}
        accessibilityLabel={hint.title}
        returnFocusRef={triggerRef}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Text
            accessibilityRole="header"
            {...typeCap("title")}
            style={{
              color: t.fg,
              fontFamily: FONT.bold,
              ...typeStyle("title"),
              flex: 1,
            }}
          >
            {hint.title}
          </Text>
          <Pressable
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close explanation"
            hitSlop={8}
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                fontFamily: FONT.semibold,
                ...typeStyle("control"),
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>

        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
            marginTop: 12,
          }}
        >
          {hint.body}
        </Text>

        {learnMore ? (
          <Pressable
            onPress={() => void Linking.openURL(learnMore)}
            accessibilityRole="link"
            accessibilityLabel={`Learn more about ${hint.title}`}
            style={{ marginTop: 16, minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                fontFamily: FONT.semibold,
                ...typeStyle("control"),
              }}
            >
              {/* U+FE0E keeps the arrow a text glyph, not an emoji, on both platforms. */}
              {"Learn more \u2197\uFE0E"}
            </Text>
          </Pressable>
        ) : null}
      </KeyboardFormSheet>
    </>
  );
}
