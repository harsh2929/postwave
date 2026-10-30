// Moosewave docs - MCP skill catalog index.
//
// Generated, reviewable details derived from packages/mcp-server/src/tools.

import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { listSkills, skillsByCategory } from "@/lib/docs/loadSkills";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
  MCP_SOURCE_CANDIDATE_LABEL,
} from "@/lib/mcp-release-status";

export const metadata: Metadata = {
  title: "MCP skills · Moosewave docs",
  description: `Review Moosewave's ${MCP_SOURCE_CANDIDATE_LABEL}. Distribution and runnable setup are release-held.`,
  alternates: { canonical: "/docs/skills" },
};

export default function SkillsIndexPage(): JSX.Element {
  const groups = skillsByCategory();
  const total = listSkills().length;
  return (
    <article className="space-y-8">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "MCP skills" },
        ]}
      />
      <header className="space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          MCP skills
        </h1>
        <p className="text-pw-muted-on-paper max-w-3xl leading-relaxed">
          This generated index describes {total} source-candidate definitions
          across {groups.length} categories. It is not an installed-package or
          deployed-runtime inventory.
        </p>
        <p className="rounded-md border border-pw-ember-500/40 bg-white p-3 text-sm text-pw-muted-on-paper">
          <span className="font-mono text-pw-ember-600">
            {MCP_RELEASE_HOLD_CODE}
          </span>{" "}
          — {MCP_RELEASE_STATUS_COPY}
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-md border border-pw-line bg-white px-2 py-1 font-mono">
            @postwave/mcp-server source candidate
          </span>
          <Link
            href="/mcp"
            className="inline-flex min-h-11 items-center rounded-md border border-pw-line bg-white px-2 py-1 transition-colors hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
          >
            Release status
          </Link>
        </div>
      </header>

      <nav
        aria-label="Category jump-list"
        className="flex flex-wrap gap-2 text-xs"
      >
        {groups.map((g) => (
          <a
            key={g.category}
            href={`#${g.category}`}
            className="inline-flex min-h-11 items-center rounded-full border border-pw-line bg-white px-3 py-1 transition-colors hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-8"
          >
            {g.category}
            <span className="ml-1 text-pw-muted-on-paper tabular-nums">
              {g.skills.length}
            </span>
          </a>
        ))}
      </nav>

      <div className="space-y-10">
        {groups.map((g) => (
          <section key={g.category} id={g.category} className="scroll-mt-20">
            <h2 className="text-xl font-semibold tracking-tight mb-3 capitalize">
              {g.category}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {g.skills.map((s) => (
                <Link
                  key={s.slug}
                  href={`/docs/skills/${s.slug}`}
                  className="rounded-md border border-pw-line bg-white p-3 hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 transition-colors"
                >
                  <div className="break-all font-mono text-sm text-pw-ink2">
                    {s.name}
                  </div>
                  <p className="mt-1 text-xs text-pw-muted-on-paper line-clamp-2">
                    {s.description}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
