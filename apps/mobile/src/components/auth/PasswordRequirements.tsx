/**
 * PasswordRequirements — the strength meter + checklist, rendered once.
 *
 * There were two hand-rolled copies (a `PwRule` grid on sign-up, a row list on
 * password reset) driven by two different rule sets with two different
 * strictnesses. This renders `src/lib/passwordPolicy.ts` — the single policy
 * aligned to the server's length-only requirement — and distinguishes the ONE
 * rule that blocks submission from the three that are advice, so the checklist
 * and the button can never disagree again.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  passwordBlockingError,
  passwordRules,
  passwordScore,
} from "@/lib/passwordPolicy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function PasswordRequirements({ password }: { password: string }) {
  const { t } = useTheme();
  if (!password) return null;

  const rules = passwordRules(password);
  const strength = passwordScore(password);
  const blocked = passwordBlockingError(password) !== null;
  const metCount = rules.filter((rule) => rule.ok).length;
  // The container is `accessible`, so VoiceOver reads this ONE label instead of
  // the rows — which means a bare "2 of 4 met" left a non-sighted user knowing
  // they had failed something but not what. Name the outstanding rules.
  const unmet = rules.filter((rule) => !rule.ok).map((rule) => rule.label);

  return (
    <View
      style={{ marginTop: 8 }}
      accessible
      accessibilityLabel={`Password strength ${strength.label}. ${metCount} of ${rules.length} recommendations met.${
        unmet.length > 0 ? ` Still to do: ${unmet.join(", ")}.` : ""
      }${blocked ? " At least 12 characters are required." : ""}`}
    >
      <View
        style={{
          height: 4,
          backgroundColor: t.borderSubtle,
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: 4,
            width: `${(strength.score / 4) * 100}%`,
            backgroundColor:
              strength.score >= 3
                ? t.success
                : strength.score >= 2
                  ? t.warning
                  : t.danger,
          }}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        Strength: {strength.label}
      </Text>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          rowGap: 4,
          marginTop: 8,
        }}
      >
        {rules.map((rule) => (
          <View
            key={rule.key}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              width: "48%",
            }}
          >
            {/* Glyph carries the state, not colour alone. It is an ICON in a
                fixed 12pt gutter and the container's label already speaks the
                state, so it is pinned against OS text scaling. */}
            <Text
              allowFontScaling={false}
              style={{
                color: rule.ok ? t.success : t.fgSubtle,
                ...typeStyle("label"),
                fontWeight: "700",
                fontFamily: FONT.bold,
                width: 12,
                textAlign: "center",
              }}
              accessibilityElementsHidden
            >
              {rule.ok ? "✓" : "·"}
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: rule.ok ? t.fg : t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                flexShrink: 1,
              }}
            >
              {rule.blocking ? rule.label : `${rule.label} (optional)`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
