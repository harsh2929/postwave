// SPDX-License-Identifier: MIT
import * as React from "react";
import { safeEmailHref } from "../lib/safe-url.js";

export interface LinkProps {
  href: string;
  color?: string;
  underline?: boolean;
  children?: React.ReactNode;
}

/**
 * Inline `<a>` styled for email. Use inside `<Text>`.
 */
export function Link(props: LinkProps): React.ReactElement {
  const { href, color = "#1f6feb", underline = true, children } = props;
  const style: React.CSSProperties = {
    color,
    textDecoration: underline ? "underline" : "none",
  };
  return (
    <a href={safeEmailHref(href)} style={style}>
      {children}
    </a>
  );
}
