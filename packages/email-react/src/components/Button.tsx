// SPDX-License-Identifier: MIT
import * as React from "react";
import { safeEmailHref } from "../lib/safe-url.js";

export interface ButtonProps {
  href: string;
  backgroundColor?: string;
  color?: string;
  fontSize?: string;
  fontWeight?: string | number;
  padding?: string;
  innerPadding?: string;
  borderRadius?: string;
  align?: "left" | "center" | "right";
  children?: React.ReactNode;
}

/** Compiles to `<mj-button>`. */
export function Button(props: ButtonProps): React.ReactElement {
  const {
    href,
    backgroundColor = "#1f6feb",
    color = "#ffffff",
    fontSize,
    fontWeight,
    padding,
    innerPadding,
    borderRadius = "6px",
    align,
    children,
  } = props;
  return (
    <mj-button
      href={safeEmailHref(href)}
      background-color={backgroundColor}
      color={color}
      font-size={fontSize}
      font-weight={fontWeight === undefined ? undefined : String(fontWeight)}
      padding={padding}
      inner-padding={innerPadding}
      border-radius={borderRadius}
      align={align}
    >
      {children}
    </mj-button>
  );
}
