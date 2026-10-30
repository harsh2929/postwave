/**
 * SubscriberSortControl — pick the list's ordering.
 *
 * The subscribers list was permanently pinned to the server default
 * (updated_at desc) even though every option offered here is an indexed
 * column the endpoint already honours. "Who joined most recently?" and
 * "who is most at risk of churning?" were desktop-only questions.
 *
 * A sheet rather than a chip row: eight options would double the height of
 * the filter header on a phone, and the sort is a single-valued choice
 * (unlike the status chips beside it), so it reads as a picker.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  SUBSCRIBER_SORTS,
  subscriberSortAccessibilityLabel,
  subscriberSortByKey,
} from "@/lib/subscriberSort";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberSortControl({
  value,
  open,
  onOpen,
  onClose,
  onChange,
}: {
  value: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (key: string) => void;
}) {
  const { t } = useTheme();
  const active = subscriberSortByKey(value);

  return (
    <>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={subscriberSortAccessibilityLabel(value)}
        // NativeWind v4: static style object only.
        style={{
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 999,
          paddingHorizontal: 12,
          paddingVertical: 8,
          minHeight: 44,
          justifyContent: "center",
          backgroundColor: t.surface,
        }}
      >
        {/* `control`: this pill shares one row with the count line beside it
            and cannot reflow, so it takes the dense control ceiling. */}
        <Text
          {...typeCap("control")}
          style={{
            color: t.fgMuted,
            ...typeStyle("control"),
            fontFamily: FONT.medium,
          }}
          numberOfLines={1}
        >
          {`Sort: ${active.label}`}
        </Text>
      </Pressable>

      <ReducedMotionModal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <SafeAreaView
          style={{ flex: 1, backgroundColor: t.bg }}
          edges={["top", "bottom"]}
          accessibilityViewIsModal
          accessibilityLabel="Sort subscribers"
        >
          <ScrollView contentContainerStyle={{ padding: 20, gap: 8 }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <Text
                {...typeCap("title")}
                style={{
                  color: t.fg,
                  ...typeStyle("title"),
                  fontWeight: "700",
                  fontFamily: FONT.display,
                }}
              >
                Sort by
              </Text>
              <Pressable
                onPress={onClose}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text
                  {...typeCap("body")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("body"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Done
                </Text>
              </Pressable>
            </View>

            {SUBSCRIBER_SORTS.map((option) => {
              const selected = option.key === active.key;
              return (
                <Pressable
                  key={option.key}
                  onPress={() => {
                    haptics.tap();
                    onChange(option.key);
                    onClose();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  // Selection is announced as state, not inferred from the
                  // checkmark glyph or the border colour.
                  accessibilityState={{ selected }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    backgroundColor: t.surface,
                    borderColor: selected ? t.accent : t.borderSubtle,
                    borderWidth: 1,
                    borderRadius: 12,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    minHeight: 48,
                  }}
                >
                  <Text
                    {...typeCap("body")}
                    style={{
                      color: t.fg,
                      ...typeStyle("body"),
                      fontFamily: FONT.medium,
                      flex: 1,
                    }}
                    numberOfLines={2}
                  >
                    {option.label}
                  </Text>
                  {selected ? (
                    <Text
                      // Decorative: selection is already announced through
                      // accessibilityState, so this glyph is icon-in-text and
                      // must not grow the row it pins.
                      allowFontScaling={false}
                      style={{
                        color: t.accent,
                        ...typeStyle("body"),
                        fontFamily: FONT.semibold,
                      }}
                      accessibilityElementsHidden
                      importantForAccessibility="no"
                    >
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </SafeAreaView>
      </ReducedMotionModal>
    </>
  );
}
