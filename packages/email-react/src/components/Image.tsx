// SPDX-License-Identifier: MIT
import * as React from "react";
import { safeEmailHref, safeEmailImageSrc } from "../lib/safe-url.js";

export interface ImageProps {
  src: string;
  alt?: string;
  href?: string;
  width?: string;
  height?: string;
  align?: "left" | "center" | "right";
  padding?: string;
}

/** Compiles to `<mj-image>`. */
export function Image(props: ImageProps): React.ReactElement {
  const { src, alt, href, width, height, align, padding } = props;
  return (
    <mj-image
      src={safeEmailImageSrc(src)}
      alt={alt}
      href={href ? safeEmailHref(href) : undefined}
      width={width}
      height={height}
      align={align}
      padding={padding}
    />
  );
}
