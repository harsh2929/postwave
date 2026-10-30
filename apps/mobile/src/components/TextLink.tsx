import type { ReactNode } from "react";
import {
  Pressable,
  Text,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { typeCap, typeStyle } from "@/lib/typeScale";

type TextLinkProps = Omit<
  PressableProps,
  "accessibilityRole" | "children" | "style"
> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

export function TextLink({
  children,
  style,
  textStyle,
  hitSlop = 12,
  accessibilityLabel,
  ...props
}: TextLinkProps) {
  const fallbackLabel = typeof children === "string" ? children : undefined;
  const label = accessibilityLabel ?? fallbackLabel;
  return (
    <Pressable
      {...props}
      accessibilityRole="link"
      {...(label ? { accessibilityLabel: label } : {})}
      hitSlop={hitSlop}
      style={[{ minHeight: 44, justifyContent: "center" }, style]}
    >
      {/* A link is prose: `body` is only a FLOOR here — `textStyle` is spread
          last so a caller that sizes its own link still wins — but the ceiling
          applies either way, so no link is left scaling without a bound. */}
      <Text {...typeCap("body")} style={[typeStyle("body"), textStyle]}>
        {children}
      </Text>
    </Pressable>
  );
}
