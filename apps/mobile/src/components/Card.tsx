import { type ViewProps, View } from "react-native";

import { CARD_GEOMETRY, type CardVariant } from "@/lib/shellStyleTokens";
import { useTheme } from "@/lib/theme";

/**
 * Card — base visual container with a slight elevation tint. Used by
 * the dashboard tiles, the subscriber detail rows, and the settings
 * groups so spacing stays consistent.
 *
 * Colors come from the runtime theme (useTheme) rather than the static
 * NativeWind dark palette, so cards flip correctly in light mode. The
 * `className` passthrough is kept for layout utilities; any `style`
 * override is merged on top.
 *
 * `variant="compact"` is the settings stack's tighter padding. It used to be a
 * SEPARATE Card declared inside SettingsScreenPrimitives that differed from
 * this one by 2px for no stated reason; making it a named variant means the
 * difference is a decision instead of drift.
 */
export function Card({
  className = "",
  variant = "default",
  style,
  ...rest
}: ViewProps & { className?: string; variant?: CardVariant }) {
  const { t } = useTheme();
  return (
    <View
      {...rest}
      className={className}
      style={[
        {
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          ...CARD_GEOMETRY[variant],
        },
        style,
      ]}
    />
  );
}
