// SPDX-License-Identifier: MIT
import * as React from "react";

export interface ColumnProps {
  width?: string;
  verticalAlign?: "top" | "middle" | "bottom";
  backgroundColor?: string;
  padding?: string;
  children?: React.ReactNode;
}

/** Compiles to `<mj-column>`. */
export function Column(props: ColumnProps): React.ReactElement {
  const { width, verticalAlign, backgroundColor, padding, children } = props;
  return (
    <mj-column
      width={width}
      vertical-align={verticalAlign}
      background-color={backgroundColor}
      padding={padding}
    >
      {children}
    </mj-column>
  );
}
