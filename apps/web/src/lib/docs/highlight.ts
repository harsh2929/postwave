// SPDX-License-Identifier: AGPL-3.0-only
//
// Build/server-time syntax highlighting for docs code blocks (Shiki). Runs
// only in server components, so the highlighted HTML is static and ships zero
// client JS. A single highlighter is cached module-wide so grammars + the
// theme load once across every code block.
import { createHighlighter, type Highlighter } from "shiki";

const THEME = "github-dark-dimmed";
const LANGS = [
  "bash",
  "json",
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "http",
  "python",
  "go",
  "sql",
  "yaml",
  "html",
  "css",
];

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({ themes: [THEME], langs: LANGS });
  }
  return highlighterPromise;
}

// Common shorthand → grammar name so callers can pass casual languages.
const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  curl: "bash",
  ts: "typescript",
  js: "javascript",
  py: "python",
  yml: "yaml",
};

/**
 * Highlight `code` as `language`, returning Shiki's `<pre><code>…` HTML. Falls
 * back to plain text for unknown languages (never throws on a bad lang).
 */
export async function highlight(
  code: string,
  language = "text",
): Promise<string> {
  const h = await getHighlighter();
  const lang = ALIASES[language] ?? language;
  const supported = h.getLoadedLanguages().includes(lang) ? lang : "text";
  return h.codeToHtml(code, { lang: supported, theme: THEME });
}
