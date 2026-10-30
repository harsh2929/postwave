/**
 * WizardNav — the onboarding wizard's Skip / Back / Next row.
 *
 * Split out of OnboardingWizard so that file stays under its source budget.
 * Behaviour is unchanged: every control keeps a >=44pt target, a spoken label
 * that names the destination rather than the glyph ("Previous step", "Finish
 * setup"), and a `control`-role type cap — the three buttons divide one row's
 * width between them, so their labels are pinned geometry that cannot reflow.
 *
 * NativeWind v4: STATIC Pressable styles only.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** iOS HIG minimum touch target. */
const MIN_TAP_TARGET = 44;

export interface WizardNavProps {
  isFirst: boolean;
  isLast: boolean;
  onSkip: () => void;
  onBack: () => void;
  onNext: () => void;
}

export function WizardNav({
  isFirst,
  isLast,
  onSkip,
  onBack,
  onNext,
}: WizardNavProps) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <Pressable
        onPress={onSkip}
        accessibilityRole="button"
        accessibilityLabel="Skip setup"
        hitSlop={8}
        style={{
          minHeight: MIN_TAP_TARGET,
          paddingHorizontal: 8,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("control"),
            fontWeight: "500",
            fontFamily: FONT.medium,
          }}
        >
          Skip
        </Text>
      </Pressable>

      <View style={{ flexDirection: "row", gap: 8 }}>
        {!isFirst ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Previous step"
            hitSlop={8}
            style={{
              minHeight: MIN_TAP_TARGET,
              minWidth: 72,
              paddingHorizontal: 14,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fg,
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Back
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onNext}
          accessibilityRole="button"
          accessibilityLabel={isLast ? "Finish setup" : "Next step"}
          hitSlop={8}
          style={{
            minHeight: MIN_TAP_TARGET,
            minWidth: 96,
            paddingHorizontal: 16,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.surfaceElevated,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.fg,
              ...typeStyle("control"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {isLast ? "Done" : "Next"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
