// SPDX-License-Identifier: MIT
import type { LintRule } from "./types.js";

/**
 * Image-to-text ratio: any email that is mostly image and very little
 * text trips spam filters. Counts `<img>` / `<Image>` / `<mj-image>`
 * occurrences against the rough text length (with tags stripped).
 *
 * Threshold: > 1 image per 200 characters of body text emits a single
 * finding pinned to the start of the document.
 */
const IMAGE_TAG_RE = /<(?:img|Image|mj-image)\b/gi;
const TAG_STRIP_RE = /<[^>]+>/g;

export const imageRatio: LintRule = (source) => {
  if (!source) return [];
  const images = source.match(IMAGE_TAG_RE)?.length ?? 0;
  if (images === 0) return [];

  const textOnly = source
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(TAG_STRIP_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const textLen = textOnly.length;

  // Heuristic threshold matched to deliverability service.
  const ratio = textLen / Math.max(1, images);
  if (ratio < 200) {
    return [
      {
        ruleId: "postwave/image-ratio",
        message: `Image-to-text ratio is too high (${images} image(s) for ${textLen} chars of text). Add more body copy or remove decorative images.`,
        start: 0,
        end: Math.min(source.length, 1),
        severity: "warning",
      },
    ];
  }
  return [];
};
