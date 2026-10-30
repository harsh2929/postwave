/**
 * ChipRow — a filter-chip row that stays ONE line.
 *
 * The cluster's chip rows all used `flexWrap: "wrap"`, which is fine at four
 * chips and terrible at eight: the DMARC screen with fifteen sending domains
 * pushed the list several rows down a phone screen, and widening the
 * suppression taxonomy from five to eight buckets would have done the same.
 * A horizontal scroller keeps the row a fixed height regardless of count and
 * is the platform-native pattern for "more options than fit".
 *
 * The row is also the place to say what the chips ARE — a bare strip of pills
 * has no accessible name, so VoiceOver announces eight unlabelled buttons.
 */
import { ScrollView, View } from "react-native";

import { Chip } from "@/components/Chip";

export interface ChipRowOption<T extends string> {
  value: T;
  label: string;
  /** Spoken label. Chip text is abbreviated ("Unsub"); this must not be. */
  accessibilityLabel?: string | undefined;
}

export interface ChipRowProps<T extends string> {
  options: readonly ChipRowOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Names the GROUP, e.g. "Filter by reason". */
  accessibilityLabel: string;
  /** Padding applied inside the scroller so chips clear the screen edge. */
  paddingHorizontal?: number;
}

export function ChipRow<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  paddingHorizontal = 16,
}: ChipRowProps<T>) {
  if (options.length === 0) return null;
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      // The wrapper owns the group name; each Chip keeps its own selected
      // state, so VoiceOver reads "Filter by reason, Hard bounce, selected".
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexDirection: "row",
          gap: 6,
          paddingHorizontal,
          alignItems: "center",
        }}
      >
        {options.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            active={option.value === value}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            onPress={() => onChange(option.value)}
          />
        ))}
      </ScrollView>
    </View>
  );
}
