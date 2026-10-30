// SPDX-License-Identifier: AGPL-3.0-only
//
// Syntax-highlighted docs code block. Server component: highlights at
// build/request time via Shiki (no client JS for the colors), wraps the
// result in the brand code-surface chrome, and mounts the tiny CopyButton
// island for clipboard. Drop-in replacement for the old CopyableCode (same
// props) — async, so it renders fine inside server-component maps.
import { highlight } from "@/lib/docs/highlight";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";

export interface CodeBlockProps {
  code: string;
  language?: string;
  caption?: string;
  className?: string;
}

export async function CodeBlock({
  code,
  language,
  caption,
  className,
}: CodeBlockProps): Promise<JSX.Element> {
  const html = await highlight(code, language ?? "text");
  return (
    <figure
      className={cn(
        "group relative my-4 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100",
        className,
      )}
    >
      {/* Top-edge light catch so the code surface reads as a lit panel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent"
      />
      <figcaption className="flex min-h-11 items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1 font-mono text-[11px] sm:px-4">
        <span className="min-w-0 truncate text-zinc-400">
          {caption ?? "Code"}
          {caption && language ? " · " : ""}
          {language ? <span className="text-zinc-400">{language}</span> : null}
        </span>
        <CopyButton code={code} />
      </figcaption>
      {/* Shiki emits its own <pre class="shiki" style="background…">; override
          the bg to sit on our zinc-950 surface for one consistent panel.
          tabIndex because this div — not the <pre> inside it — is the scroll
          container, and code samples overflow constantly. A scroll region that
          cannot take focus cannot be scrolled without a mouse (WCAG 2.1.1).
          role="group" rather than "region" so a docs page with a dozen samples
          does not gain a dozen landmarks. */}
      <div
        tabIndex={0}
        role="group"
        aria-label={
          caption
            ? `${caption} code sample`
            : `${language ?? "Code"} code sample`
        }
        className="overflow-x-auto overscroll-x-contain px-4 py-3 text-[12.5px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 [&_code]:!bg-transparent [&_pre]:m-0 [&_pre]:!bg-transparent"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </figure>
  );
}
