/**
 * FromNameSuggestionsRow — the tenant's top-performing sender names as
 * apply chips under the from-name field (desktop parity:
 * components/composer/FromNameSuggestions.tsx).
 *
 * The server enforces its own min-campaigns floor, so an EMPTY answer hides
 * the whole strip — no fake suggestions, no empty chrome. A fetch failure
 * also renders nothing: this is a convenience read and must never block the
 * identity sheet (desktop shows a retry line; on a sheet this small, silence
 * is the mobile translation — the field itself is unaffected).
 *
 * NativeWind v4 house rule: static Pressable styles only (Chip complies).
 */
import { ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { Chip } from "@/components/Chip";
import { fetchFromNameSuggestions } from "@/api/fromNamePicker";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { fromNameSuggestionLabel } from "@/lib/fromNamePicker";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

/** Engagement history moves per send, not per keystroke. */
const SUGGESTIONS_STALE_MS = 5 * 60_000;

export function FromNameSuggestionsRow({
  current,
  onApply,
}: {
  /** The draft's current from-name — the matching chip renders active. */
  current: string;
  onApply: (fromName: string) => void;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const suggestions = useQuery({
    queryKey: ["from-name-picker", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: SUGGESTIONS_STALE_MS,
    queryFn: fetchFromNameSuggestions,
  });

  // `?? []` would substitute only for null/undefined and pass a truthy
  // non-array straight into `.map` (lib/nullishArrayGuard.test.ts).
  const rows = Array.isArray(suggestions.data) ? suggestions.data : [];
  if (rows.length === 0) return null;

  return (
    <View style={{ marginTop: -4, marginBottom: 8, gap: 4 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontSize: 11,
          fontFamily: FONT.regular,
        }}
      >
        Top performers by historical engagement:
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 6 }}
      >
        {rows.map((row) => (
          <Chip
            key={row.fromName}
            label={row.fromName}
            active={current.trim() === row.fromName}
            accessibilityLabel={fromNameSuggestionLabel(row)}
            onPress={() => onApply(row.fromName)}
          />
        ))}
      </ScrollView>
    </View>
  );
}
