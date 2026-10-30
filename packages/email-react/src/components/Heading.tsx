// SPDX-License-Identifier: MIT
import * as React from "react";
import { Text, type TextProps } from "./Text.js";

export interface HeadingProps extends Omit<TextProps, "fontSize" | "fontWeight"> {
  level?: 1 | 2 | 3;
  children?: React.ReactNode;
}

const SIZES: Record<1 | 2 | 3, string> = {
  1: "28px",
  2: "22px",
  3: "18px",
};

/** Heading defaults applied on top of `<mj-text>`. */
export function Heading(props: HeadingProps): React.ReactElement {
  const { level = 1, children, ...rest } = props;
  return (
    <Text fontSize={SIZES[level]} fontWeight={700} lineHeight="1.25" {...rest}>
      {children}
    </Text>
  );
}
