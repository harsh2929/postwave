// SPDX-License-Identifier: MIT
import * as React from "react";
import { safeEmailHref } from "../lib/safe-url.js";

export interface SocialItem {
  name:
    | "twitter"
    | "facebook"
    | "instagram"
    | "linkedin"
    | "youtube"
    | "github"
    | "tiktok"
    | "web";
  href: string;
}

export interface SocialRowProps {
  items: SocialItem[];
  align?: "left" | "center" | "right";
  iconSize?: string;
  mode?: "horizontal" | "vertical";
}

/** Compiles to `<mj-social>` with one `<mj-social-element>` per item. */
export function SocialRow(props: SocialRowProps): React.ReactElement {
  const { items, align = "center", iconSize = "20px", mode = "horizontal" } = props;
  return (
    <mj-social align={align} icon-size={iconSize} mode={mode}>
      {items.map((it, i) => (
        <mj-social-element key={i} name={it.name} href={safeEmailHref(it.href)} />
      ))}
    </mj-social>
  );
}
