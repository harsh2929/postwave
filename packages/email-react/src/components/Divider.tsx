// SPDX-License-Identifier: MIT
import * as React from "react";

export interface DividerProps {
  borderColor?: string;
  borderWidth?: string;
  borderStyle?: "solid" | "dashed" | "dotted";
  padding?: string;
  width?: string;
}

/** Compiles to `<mj-divider>`. */
export function Divider(props: DividerProps): React.ReactElement {
  const { borderColor = "#e5e7eb", borderWidth = "1px", borderStyle = "solid", padding, width } =
    props;
  return (
    <mj-divider
      border-color={borderColor}
      border-width={borderWidth}
      border-style={borderStyle}
      padding={padding}
      width={width}
    />
  );
}
