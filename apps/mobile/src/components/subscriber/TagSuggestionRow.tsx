/**
 * TagSuggestionRow — the taxonomy typeahead under the new-tag box.
 *
 * Renders the ranked suggestions from `GET /api/v1/tag-taxonomy/suggest`
 * as tappable chips so an operator picks an EXISTING tag instead of
 * thumb-typing a near-duplicate. Each chip carries its live usage count,
 * which is both the ranking signal and the reason to trust it ("vip · 1.2k"
 * is obviously the real one next to a stray "vips · 1").
 *
 * A11y: the visible count is compacted ("1.2k"), so the spoken label
 * carries the EXACT number — src/lib/tagSuggestions.ts owns that wording.
 * Chips are ≥44pt tall and expose accessibilityRole="button".
 *
 * NativeWind v4: static style objects only. A `style={({pressed}) => …}`
 * on a Pressable silently drops layout in this codebase.
 */
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { compactNum } from "@/lib/format";
import {
  tagSuggestionLabel,
  type TagSuggestion,
} from "@/lib/tagSuggestions";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function TagSuggestionRow({
  suggestions,
  isLoading,
  disabled,
  onPick,
  t,
}: {
  suggestions: readonly TagSuggestion[];
  /** True only while the FIRST page for this query is in flight. */
  isLoading: boolean;
  disabled: boolean;
  onPick: (tag: string) => void;
  t: ThemeTokens;
}) {
  if (isLoading) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 10,
          minHeight: 32,
        }}
        accessible
        accessibilityLabel="Looking for matching tags"
      >
        <ActivityIndicator size="small" color={t.fgSubtle} />
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Looking for matching tags…
        </Text>
      </View>
    );
  }

  if (suggestions.length === 0) return null;

  return (
    <View style={{ marginTop: 10 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginBottom: 6,
          fontFamily: FONT.regular,
        }}
      >
        Existing tags
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexDirection: "row", gap: 6, paddingEnd: 8 }}
      >
        {suggestions.map((suggestion) => (
          <Pressable
            key={suggestion.tag}
            onPress={() => onPick(suggestion.tag)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={tagSuggestionLabel(suggestion)}
            accessibilityState={{ disabled }}
            hitSlop={6}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              minHeight: 44,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {/* Dense: the chip carries an explicit `maxWidth: 160` inside a
                horizontal scroller, so it is pinned geometry. */}
            <Text
              numberOfLines={1}
              {...typeCap("control")}
              style={{
                color: t.fg,
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
                maxWidth: 160,
              }}
            >
              {suggestion.tag}
            </Text>
            {suggestion.subscribers > 0 ? (
              <Text
                {...typeCap("badgeSmall")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("badgeSmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {compactNum(suggestion.subscribers)}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
