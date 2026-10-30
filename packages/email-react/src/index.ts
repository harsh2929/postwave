// SPDX-License-Identifier: MIT
//
// @postwave/email-react — JSX → MJML compiler for Moosewave email
// components. Author email components in React, render to MJML or to
// email-safe HTML, then send via the Moosewave API.

export { Email, type EmailProps } from "./components/Email.js";
export { Section, type SectionProps } from "./components/Section.js";
export { Column, type ColumnProps } from "./components/Column.js";
export { Text, type TextProps } from "./components/Text.js";
export { Heading, type HeadingProps } from "./components/Heading.js";
export { Button, type ButtonProps } from "./components/Button.js";
export { Image, type ImageProps } from "./components/Image.js";
export { Divider, type DividerProps } from "./components/Divider.js";
export { Spacer, type SpacerProps } from "./components/Spacer.js";
export { Link, type LinkProps } from "./components/Link.js";
export {
  SocialRow,
  type SocialRowProps,
  type SocialItem,
} from "./components/SocialRow.js";
export { Footer, type FooterProps } from "./components/Footer.js";

export { renderToMjml } from "./render/to-mjml.js";
export {
  renderMjmlToHtml,
  renderToHtml,
  type RenderToHtmlOptions,
  type RenderToHtmlResult,
} from "./render/to-html.js";

// Starter templates — production-ready, brand-themable React components
// for the 16 most common email types. Import the template, pass props,
// and await renderMjmlToHtml(renderToMjml(template)).
export * from "./templates/index.js";
