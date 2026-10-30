// SPDX-License-Identifier: AGPL-3.0-only

import type { SavedBlock } from "@/lib/content-library-api";

export type TemplateSnippetFormat = "html" | "mjml";

/** A copy, not a live reference. Never guess an HTML↔MJML conversion. */
export function savedBlockSource(
  block: SavedBlock,
  format: TemplateSnippetFormat,
): string | null {
  const metadata = block.bodyJson;
  const storedFormat = metadata.moosewave_template_fragment_format;
  const storedSource = metadata.source;
  if (storedFormat === format && typeof storedSource === "string") {
    const source = storedSource.trim();
    if (!source) return null;
    if (format === "mjml" && /<\/?(?:mjml|mj-body)\b/i.test(source)) {
      return null;
    }
    return storedSource;
  }
  if (format === "html" && storedFormat !== "mjml" && block.bodyHtml.trim()) {
    return block.bodyHtml;
  }
  return null;
}
