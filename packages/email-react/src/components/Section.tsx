// SPDX-License-Identifier: MIT
import * as React from "react";

export interface SectionProps {
  backgroundColor?: string;
  padding?: string;
  textAlign?: "left" | "center" | "right";
  /** CSS border shorthand, e.g. "1px solid #E0DDD3". */
  border?: string;
  /** Left-edge accent, e.g. "3px solid #C8102E" (the brand left-rail motif). */
  borderLeft?: string;
  /** Corner radius, e.g. "6px" (best-effort; squares off in Outlook). */
  borderRadius?: string;
  children?: React.ReactNode;
}

/** Compiles to `<mj-section>`. */
export function Section(props: SectionProps): React.ReactElement {
  const {
    backgroundColor,
    padding,
    textAlign,
    border,
    borderLeft,
    borderRadius,
    children,
  } = props;
  return (
    <mj-section
      background-color={backgroundColor}
      padding={padding}
      text-align={textAlign}
      border={border}
      border-left={borderLeft}
      border-radius={borderRadius}
    >
      {children}
    </mj-section>
  );
}
