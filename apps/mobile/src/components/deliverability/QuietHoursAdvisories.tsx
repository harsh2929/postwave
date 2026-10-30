/**
 * components/deliverability/QuietHoursAdvisories — the two advisory notices
 * under the quiet-hours fields.
 *
 * Extracted purely to move branching out of SendingThrottleForm, which sat at
 * cyclomatic complexity 30 against a 25 ceiling. These two notices carried the
 * remaining branches: one fires when the chosen timezone differs from the
 * device's, the other when the chosen zone observes DST, and each nests
 * further conditions inside.
 *
 * Both are advisories, never refusals — a timezone that disagrees with the
 * handset is entirely legitimate for an operator scheduling for an audience
 * elsewhere, and the DST note explains a real one-hour shift rather than
 * discouraging the choice. Neither gates saving.
 */
import { Pressable, Text } from "react-native";

import type { useSendingSettingsForm } from "@/hooks/useSendingSettingsForm";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function QuietHoursAdvisories({
  quietTz,
  deviceTz,
  dst,
  setForm,
  disabled,
}: {
  quietTz: string;
  deviceTz: string | null;
  dst: string | null;
  setForm: ReturnType<typeof useSendingSettingsForm>["setForm"];
  disabled: boolean;
}) {
  const { t } = useTheme();
  return (
    <>
      {deviceTz && quietTz.trim() !== deviceTz ? (
        <Pressable
          onPress={() => {
            haptics.tap();
            setForm((f) => ({ ...f, quietTz: deviceTz }));
          }}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Use this device's timezone, ${deviceTz}`}
          accessibilityState={{ disabled }}
          hitSlop={8}
          style={{
            minHeight: 44,
            justifyContent: "center",
            marginTop: -6,
            marginBottom: 10,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontFamily: FONT.semibold,
            }}
          >
            {`Use this device's timezone (${deviceTz})`}
          </Text>
        </Pressable>
      ) : null}

      {dst ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("label")}
          style={{
            color: t.warning,
            ...typeStyle("label"),
            marginBottom: 12,
            fontFamily: FONT.regular,
          }}
        >
          {dst}
        </Text>
      ) : null}
    </>
  );
}
