// SPDX-License-Identifier: MIT
import * as React from "react";

export interface TextProps {
  color?: string;
  fontSize?: string;
  fontWeight?: string | number;
  lineHeight?: string | number;
  align?: "left" | "center" | "right" | "justify";
  padding?: string;
  fontFamily?: string;
  /** e.g. "-0.01em" — tightens display/wordmark text. */
  letterSpacing?: string;
  children?: React.ReactNode;
}

/** Compiles to `<mj-text>`. Children may include inline elements (links, etc.). */
export function Text(props: TextProps): React.ReactElement {
  const {
    color,
    fontSize,
    fontWeight,
    lineHeight,
    align,
    padding,
    fontFamily,
    letterSpacing,
    children,
  } = props;
  return (
    <mj-text
      color={color}
      font-size={fontSize}
      font-weight={fontWeight === undefined ? undefined : String(fontWeight)}
      line-height={lineHeight === undefined ? undefined : String(lineHeight)}
      align={align}
      padding={padding}
      font-family={fontFamily}
      letter-spacing={letterSpacing}
    >
      {children}
    </mj-text>
  );
}
