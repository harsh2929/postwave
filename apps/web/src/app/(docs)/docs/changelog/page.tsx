// Docs changelog page.
//
// Renders every package's CHANGELOG.md, bundled at build time by
// lib/docs/package-changelogs (the release image carries no packages/ tree to
// read at request time). react-markdown with remark-gfm for tables and
// strikethrough.

import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { packageChangelogs } from "@/lib/docs/package-changelogs";
import { compactProse } from "@/styles/compact-prose";

export const metadata: Metadata = {
  title: "Changelog · Moosewave docs",
  description: "Release notes for every Moosewave package.",
  alternates: { canonical: "/docs/changelog" },
};

export default function ChangelogPage(): JSX.Element {
  const items = packageChangelogs();
  return (
    <article className="space-y-8">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "Changelog" },
        ]}
      />

      <header className="space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          Changelog
        </h1>
        <p className="text-pw-muted-on-paper max-w-3xl leading-relaxed">
          Per-package release notes. The Keep-a-Changelog format is the source
          of truth. Combined release notes for the whole product live on the{" "}
          <Link className="underline" href="/changelog">
            marketing changelog
          </Link>
          .
        </p>
      </header>

      {items.length === 0 ? (
        <p className="text-sm text-pw-muted-on-paper italic">
          No CHANGELOG.md files found.
        </p>
      ) : null}

      <div className="space-y-10">
        {items.map((it) => (
          <section
            key={it.name}
            id={it.name.replace(/[@/]/g, "-")}
            className="rounded-md border border-pw-line bg-white p-5 scroll-mt-20"
          >
            <h2 className="text-lg font-semibold font-mono mb-3">{it.name}</h2>
            <div
              className={`${compactProse.root} ${compactProse.small} ${compactProse.changelog} max-w-none`}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // Every package file starts with its own `# Changelog`, which
                  // duplicates this page's title. The package heading above is
                  // the section title, so drop that duplicate and nest source
                  // levels beneath the section instead of creating ten h1s.
                  h1: () => null,
                  h2: ({ children }) => <h3>{children}</h3>,
                  h3: ({ children }) => <h4>{children}</h4>,
                  h4: ({ children }) => <h5>{children}</h5>,
                }}
              >
                {it.body}
              </ReactMarkdown>
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
