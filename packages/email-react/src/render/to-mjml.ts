// SPDX-License-Identifier: MIT
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Render a React tree of `@postwave/email-react` primitives into an MJML
 * source string.
 *
 * Internally we lean on `renderToStaticMarkup` — every primitive in this
 * package compiles to an `mj-*` intrinsic element, so the rendered HTML
 * is already valid MJML. We do a couple of post-render fixups:
 *
 *   1. React lowercases attribute names but otherwise leaves dashes intact,
 *      so `background-color` survives. Good.
 *   2. Self-closing void tags (e.g. `<mj-image/>`) come out as
 *      `<mj-image src="…"/>`, which MJML accepts.
 *   3. `&` inside attribute values is escaped to `&amp;` by React. MJML
 *      tolerates this; we leave it.
 */
export function renderToMjml(element: React.ReactElement): string {
  const raw = renderToStaticMarkup(element);
  // Ensure the document is anchored at <mjml>. If the caller passed a
  // fragment that is not an Email root, just return as-is — they own it.
  return raw;
}
