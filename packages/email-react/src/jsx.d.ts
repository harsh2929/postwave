// SPDX-License-Identifier: MIT
//
// Augment React's intrinsic-element table so the MJML tags we emit
// (mj-*) typecheck without needing `any`. Attributes are loose strings
// because MJML accepts arbitrary CSS-ish attributes per tag.

import "react";

type MjmlAttrs = {
  children?: React.ReactNode;
  [attr: string]: unknown;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      mjml: MjmlAttrs;
      "mj-head": MjmlAttrs;
      "mj-title": MjmlAttrs;
      "mj-preview": MjmlAttrs;
      "mj-attributes": MjmlAttrs;
      "mj-all": MjmlAttrs;
      "mj-body": MjmlAttrs;
      "mj-section": MjmlAttrs;
      "mj-column": MjmlAttrs;
      "mj-text": MjmlAttrs;
      "mj-button": MjmlAttrs;
      "mj-image": MjmlAttrs;
      "mj-divider": MjmlAttrs;
      "mj-spacer": MjmlAttrs;
      "mj-social": MjmlAttrs;
      "mj-social-element": MjmlAttrs;
      "mj-raw": MjmlAttrs;
    }
  }
}
