/**
 * CliScopeList — the grant-disclosure card on the CLI device-approval screen.
 *
 * It renders twice with different meanings: BEFORE approval it shows what the
 * tap *will* grant (derived from this session's effective role the way
 * `cliScopesForPrincipal` does), and AFTER approval it shows what the server
 * actually returned. Keeping one component for both is deliberate — if the two
 * lists ever drift apart visually, the user cannot compare what they were
 * promised against what they got.
 *
 * Lifted out of app/(tabs)/cli-approve.tsx so that screen stays a state → view
 * switch and both files sit under their source budgets.
 */
import { Text, View } from "react-native";

import { scopeDisclosure, scopeSummary } from "@/lib/cliScopes";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CliScopeList({
  scopes,
  title,
  emptyCopy,
}: {
  scopes: readonly string[];
  title: string;
  emptyCopy: string;
}) {
  const { t } = useTheme();
  const lines = scopeDisclosure(scopes);
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 8,
      }}
      accessible
      accessibilityLabel={`${title}. ${scopeSummary(scopes)}`}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {title}
      </Text>
      {lines.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {emptyCopy}
        </Text>
      ) : (
        lines.map((line) => (
          <View
            key={line.scope}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
          >
            {/* A glyph, not a colour: write access has to be distinguishable
                without colour vision. The glyph itself is decorative — the
                distinction is spelled out in the label beside it ("… (write)")
                and in the card's own accessibilityLabel — so it is hidden from
                VoiceOver and pinned against OS text scaling rather than
                overflowing its fixed 14pt gutter. */}
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              allowFontScaling={false}
              style={{
                color: line.write ? t.warning : t.fgSubtle,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.semibold,
                width: 14,
              }}
            >
              {line.write ? "!" : "·"}
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                flex: 1,
                fontFamily: FONT.regular,
              }}
            >
              {line.write ? `${line.label} (write)` : line.label}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}
