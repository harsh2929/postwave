// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Read-only renderer for a subscriber note's markdown source (SUB-097).
//
// Raw HTML is never interpreted (skipHtml + an element allowlist), links are
// limited to http(s)/mailto through react-markdown's default URL transform,
// and inline mention tokens — `@[Name](user:<uuid>)`, the shape the server's
// extractor stores — render as a teammate pill rather than a link.

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";

import { NOTE_MENTION_TOKEN_RE } from "@/lib/subscriber-profile-api";

const ALLOWED_ELEMENTS = [
  "p",
  "br",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
];

const MENTION_HREF_RE =
  /^user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `@[Name](user:id)` → `[@Name](user:id)` so the pill carries the `@`. */
function withMentionLinks(source: string): string {
  return source.replace(
    new RegExp(NOTE_MENTION_TOKEN_RE.source, "g"),
    (_token, display: string, userId: string) =>
      `[@${display}](user:${userId})`,
  );
}

export function NoteMarkdown({ source }: { source: string }) {
  return (
    <div className="space-y-2 text-sm [overflow-wrap:anywhere]">
      <ReactMarkdown
        skipHtml
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        urlTransform={(url) =>
          MENTION_HREF_RE.test(url) ? url : defaultUrlTransform(url)
        }
        components={{
          h1: ({ children }) => <p className="font-semibold">{children}</p>,
          h2: ({ children }) => <p className="font-semibold">{children}</p>,
          h3: ({ children }) => <p className="font-medium">{children}</p>,
          h4: ({ children }) => <p className="font-medium">{children}</p>,
          // Styled on the rendered elements instead of `[&_ul]`-style
          // variants on the wrapper: same result, and these utilities already
          // exist in the stylesheet.
          ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
          ol: ({ children }) => (
            <ol className="list-decimal pl-5">{children}</ol>
          ),
          code: ({ children }) => (
            <code className="rounded bg-muted px-1">{children}</code>
          ),
          a: ({ href, children }) => {
            if (href && MENTION_HREF_RE.test(href)) {
              return (
                <span
                  data-mention-user={href.slice("user:".length).toLowerCase()}
                  className="rounded bg-primary/10 px-1 font-medium text-primary"
                >
                  {children}
                </span>
              );
            }
            if (!href) return <span>{children}</span>;
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-primary underline underline-offset-2"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {withMentionLinks(source)}
      </ReactMarkdown>
    </div>
  );
}
