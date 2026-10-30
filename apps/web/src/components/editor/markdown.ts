// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal markdown -> HTML for seeding Tiptap. Tiptap's source of truth is
 * HTML; this only needs to round-trip plain markdown documents in.
 */
export function markdownToHtml(md: string): string {
  if (!md.trim()) return "";
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList: "ul" | "ol" | null = null;
	let inQuote = false;
	let inFence = false;
	let fenceLanguage = "";
	let fenceLines: string[] = [];
  const closeList = () => {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  };
	const closeQuote = () => {
	  if (inQuote) {
		out.push("</blockquote>");
		inQuote = false;
	  }
	};
	const closeBlocks = () => {
	  closeList();
	  closeQuote();
	};
  for (const raw of lines) {
    const line = raw;
	if (inFence) {
	  if (/^\s*```\s*$/.test(line)) {
		const languageClass = fenceLanguage
		  ? ` class="language-${escapeHtml(fenceLanguage)}"`
		  : "";
		out.push(`<pre><code${languageClass}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
		inFence = false;
		fenceLanguage = "";
		fenceLines = [];
	  } else {
		fenceLines.push(line);
	  }
	  continue;
	}
	const fence = /^\s*```([\w+-]*)\s*$/.exec(line);
	if (fence) {
	  closeBlocks();
	  inFence = true;
	  fenceLanguage = fence[1];
	  continue;
	}
    if (/^\s*$/.test(line)) {
	  closeBlocks();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
	  closeBlocks();
      const level = h[1].length;
      out.push(`<h${level}>${escapeHtml(h[2])}</h${level}>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
	  closeQuote();
      if (inList !== "ul") {
        closeList();
        inList = "ul";
        out.push("<ul>");
      }
      out.push(`<li>${inlineMd(ul[1])}</li>`);
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
	  closeQuote();
      if (inList !== "ol") {
        closeList();
        inList = "ol";
        out.push("<ol>");
      }
      out.push(`<li>${inlineMd(ol[1])}</li>`);
      continue;
    }
	const quote = /^>\s?(.*)$/.exec(line);
	if (quote) {
	  closeList();
	  if (!inQuote) {
		inQuote = true;
		out.push("<blockquote>");
	  }
	  out.push(`<p>${inlineMd(quote[1])}</p>`);
	  continue;
	}
	closeBlocks();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
	if (inFence) {
	  const languageClass = fenceLanguage
		? ` class="language-${escapeHtml(fenceLanguage)}"`
		: "";
	  out.push(`<pre><code${languageClass}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
	}
	closeBlocks();
  return out.join("");
}

export function normalizeEditorHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.username || url.password) return null;
      return url.toString();
    }
    if (url.protocol === "mailto:" || url.protocol === "tel:") {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function inlineMd(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  s = s.replace(/\[(.+?)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const safeHref = normalizeEditorHref(unescapeMarkdownHref(href));
    if (!safeHref) return label;
    return `<a href="${escapeHtml(safeHref)}" rel="noreferrer">${label}</a>`;
  });
  return s;
}

function unescapeMarkdownHref(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
