// SPDX-License-Identifier: MIT
import * as React from "react";

export interface SpacerProps {
  height?: string;
}

/** Compiles to `<mj-spacer>`. */
export function Spacer(props: SpacerProps): React.ReactElement {
  const { height = "20px" } = props;
  return <mj-spacer height={height} />;
}
