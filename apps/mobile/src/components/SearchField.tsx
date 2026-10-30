/**
 * SearchField — the one search input for every list screen.
 *
 * Each list screen previously hand-rolled a `TextInput` with its own padding,
 * its own placeholder colour, and its own (or no) clear affordance. The
 * differences were invisible individually and obvious in aggregate: some
 * screens had a clear button, some made you backspace 40 characters; some
 * debounced, some fired a query per keystroke; none announced the result count
 * to VoiceOver, so a screen-reader user typed into a void.
 *
 * What this standardises:
 *  - a CLEAR button that appears only when there is something to clear, at a
 *    full 44pt target (the common hand-rolled version was a 16pt "×");
 *  - `returnKeyType="search"` + `clearButtonMode` so the OS keyboard offers the
 *    right affordances;
 *  - autoCorrect/autoCapitalize OFF — search terms here are emails, tag names,
 *    and IDs, and autocapitalising the first letter of an email address is a
 *    small, constant papercut;
 *  - an `accessibilityLiveRegion` result summary, so filtering announces
 *    "12 results" instead of silently changing the list beneath the cursor.
 *
 * Debouncing stays with the caller (`useDebounced`) because the right delay
 * depends on whether the filter is local (instant) or a network round trip.
 */
import { useRef } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface SearchFieldProps {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  /** Screen-reader label. Defaults to the placeholder. */
  accessibilityLabel?: string;
  /**
   * Number of rows currently shown. When provided, a polite live region
   * announces it as the user types — the only way a VoiceOver user learns
   * their query narrowed anything.
   */
  resultCount?: number | undefined;
  /** Noun for the count announcement, e.g. "tag" → "12 tags". */
  resultNoun?: string;
  /**
   * Plural for `resultNoun` when "+s" is wrong.
   *
   * The naive `${noun}s` this used to build announced "3 matchs" on the two
   * screens that count MATCHES — a defect only a VoiceOver user would ever
   * hit, which is exactly why it survived. Shared with lib/format's `plural`
   * so the spoken count and any printed count agree.
   */
  resultNounPlural?: string | undefined;
  onSubmit?: (() => void) | undefined;
  autoFocus?: boolean;
  /**
   * Almost always "none" — see the note above. The one honest exception is a
   * field that searches an ALL-CAPS identifier space (discount codes), where
   * "characters" saves the shift key on every character and can never produce
   * a wrong match, since the filter is case-insensitive either way.
   */
  autoCapitalize?: "none" | "characters";
  /**
   * Keyboard layout. Set `"email-address"` on a field that searches ONLY
   * addresses (suppressions, SMS opt-outs) so @ and . are on the primary
   * plane. Do NOT set it on a field that also searches names or tags: the
   * email keyboard drops the space bar on iOS, which makes typing a person's
   * name worse than the default layout makes typing an address.
   */
  keyboardType?: "default" | "email-address";
}

export function SearchField({
  value,
  onChangeText,
  placeholder = "Search",
  accessibilityLabel,
  resultCount,
  resultNoun = "result",
  resultNounPlural,
  onSubmit,
  autoFocus = false,
  autoCapitalize = "none",
  keyboardType = "default",
}: SearchFieldProps) {
  const { t } = useTheme();
  const inputRef = useRef<TextInput>(null);

  const clear = () => {
    haptics.tap();
    onChangeText("");
    // Keep focus so the user can immediately retype — dismissing the keyboard
    // on clear forces a second tap to continue searching.
    inputRef.current?.focus();
  };

  const announcement =
    typeof resultCount === "number"
      ? plural(resultCount, resultNoun, resultNounPlural)
      : null;

  return (
    <View style={{ gap: 4 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 12,
          // Logical, not physical: Android declares supportsRtl="true", so on
          // an RTL locale Yoga mirrors this row and a physical `paddingLeft`
          // would leave the 12pt gutter under the magnifier on the wrong side
          // and crowd the clear button against the border.
          paddingStart: 12,
          paddingEnd: value ? 4 : 12,
          minHeight: 44,
        }}
      >
        <SearchGlyph color={t.fgSubtle} />
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel={accessibilityLabel ?? placeholder}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          keyboardType={keyboardType}
          // Search fields must never offer the SIGNED-IN user's own address:
          // `textContentType="emailAddress"` would autofill it, which is
          // never the address being looked up.
          textContentType="none"
          returnKeyType="search"
          // iOS draws its own clear button inside the field; on Android we
          // render ours. Showing both on iOS would be a duplicate control.
          clearButtonMode={Platform.OS === "ios" ? "while-editing" : "never"}
          onSubmitEditing={onSubmit}
          // Size + ceiling from the scale, but NOT `lineHeight`: an explicit
          // leading on a TextInput mis-centres the caret and clips descenders
          // on Android. The 44pt shell is a minHeight, so the field grows.
          {...typeCap("body")}
          style={{
            flex: 1,
            color: t.fg,
            fontFamily: FONT.regular,
            fontSize: fontSizeFor("body"),
            paddingVertical: 10,
            paddingHorizontal: 8,
          }}
        />
        {value && Platform.OS !== "ios" ? (
          <Pressable
            onPress={clear}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={8}
            style={{
              minWidth: 40,
              minHeight: 40,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* The "×" is an ICON drawn with a glyph, not text — the button's
                meaning is carried by its accessibilityLabel. Icons in chrome do
                not scale with Dynamic Type on iOS, and letting this one scale
                inside a 40pt target is how it clips. */}
            <Text
              allowFontScaling={false}
              style={{ color: t.fgSubtle, fontFamily: FONT.medium, fontSize: 18 }}
            >
              ×
            </Text>
          </Pressable>
        ) : null}
      </View>

      {announcement ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("label"),
            paddingHorizontal: 4,
          }}
        >
          {announcement}
        </Text>
      ) : null}
    </View>
  );
}

/** 16pt magnifier drawn with views — avoids pulling react-native-svg into
 *  a primitive that every list screen mounts. */
function SearchGlyph({ color }: { color: string }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: 16, height: 16, justifyContent: "center" }}
    >
      <View
        style={{
          width: 11,
          height: 11,
          borderRadius: 6,
          borderWidth: 1.6,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 6,
          height: 1.6,
          backgroundColor: color,
          bottom: 1,
          // `end`, not `right`: a magnifier's handle points at the trailing
          // corner, and RTL mirrors the glyph with the rest of the row.
          end: -1,
          transform: [{ rotate: "45deg" }],
        }}
      />
    </View>
  );
}
