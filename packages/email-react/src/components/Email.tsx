// SPDX-License-Identifier: MIT
import * as React from "react";

export interface EmailProps {
  /** Inbox preview text (mj-preview). */
  preview?: string;
  /** Optional title for clients that show it. */
  title?: string;
  /** Default body width in pixels. */
  width?: number;
  /** Default background color for mj-body. */
  backgroundColor?: string;
  /** Default font-family applied via mj-attributes mj-all. */
  fontFamily?: string;
  children?: React.ReactNode;
}

/**
 * Root layout. Compiles to `<mjml><mj-head/><mj-body/></mjml>`.
 * Pass Sections as children.
 */
export function Email(props: EmailProps): React.ReactElement {
  const {
    preview,
    title,
    width = 600,
    backgroundColor = "#ffffff",
    fontFamily = "Helvetica, Arial, sans-serif",
    children,
  } = props;

  return (
    <mjml>
      <mj-head>
        {title ? <mj-title>{title}</mj-title> : null}
        {preview ? <mj-preview>{preview}</mj-preview> : null}
        <mj-attributes>
          <mj-all font-family={fontFamily} />
        </mj-attributes>
      </mj-head>
      <mj-body width={`${width}px`} background-color={backgroundColor}>
        {children}
      </mj-body>
    </mjml>
  );
}
