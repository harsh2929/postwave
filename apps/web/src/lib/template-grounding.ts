// SPDX-License-Identifier: AGPL-3.0-only

/** Advisory checks only: these cannot prove that marketing copy is factual. */
export function reviewGeneratedTemplateGrounding(
  html: string,
  subject: string,
  content: Record<string, unknown> | undefined,
): string[] {
  const facts = Array.isArray(content?.approved_facts)
    ? content.approved_facts.filter((value): value is string => typeof value === "string")
    : [];
  const approvedURLs = new Set(
    Array.isArray(content?.approved_urls)
      ? content.approved_urls.filter((value): value is string => typeof value === "string")
      : [],
  );
  const approvedAssets = new Set(
    Array.isArray(content?.approved_assets)
      ? content.approved_assets
          .filter((value): value is { url: string } =>
            Boolean(value) && typeof value === "object" && typeof value.url === "string",
          )
          .map((value) => value.url)
      : [],
  );
  const warnings: string[] = [];
  const hrefs = Array.from(html.matchAll(/\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/gi), (match) =>
    match[1].replaceAll("&amp;", "&"),
  );
  const unapproved = Array.from(new Set(hrefs.filter((url) =>
    !approvedURLs.has(url) && !/\{\{[^{}]+\}\}/.test(url),
  )));
  if (unapproved.length) {
    warnings.push(`${unapproved.length} external link${unapproved.length === 1 ? "" : "s"} in the draft were not in the approved-link list: ${unapproved.slice(0, 3).join(", ")}${unapproved.length > 3 ? "…" : ""}.`);
  }
  const imageURLs = Array.from(html.matchAll(/<(?:img|mj-image)\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi), (match) =>
    match[1].replaceAll("&amp;", "&"),
  );
  const unapprovedImages = Array.from(new Set(imageURLs.filter((url) => !approvedAssets.has(url))));
  if (unapprovedImages.length) {
    warnings.push(`${unapprovedImages.length} image URL${unapprovedImages.length === 1 ? "" : "s"} in the draft were not selected from approved workspace assets. Verify licensing, hosting, and alt text.`);
  }
  const visible = html
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ");
  const claims = Array.from(new Set(
    `${subject} ${visible}`.match(/(?:[$€£]\s?\d+(?:[.,]\d+)*|\b\d+(?:[.,]\d+)?\s?%)/g) ?? [],
  ));
  const unsupported = claims.filter((claim) => !facts.some((fact) => fact.includes(claim)));
  if (unsupported.length) {
    warnings.push(`Check numerical or price claims not found verbatim in approved facts: ${unsupported.slice(0, 8).join(", ")}${unsupported.length > 8 ? "…" : ""}.`);
  }
  if (facts.length || approvedURLs.size || approvedAssets.size) {
    warnings.push("Grounding is advisory: approved facts and URLs were supplied by an operator, not independently verified; review all copy before use.");
  }
  return warnings;
}
