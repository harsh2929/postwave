// Moosewave docs - per-skill detail page. Long-tail pages are generated and
// cached on first request instead of duplicating every page in the image.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { findSkillBySlug } from "@/lib/docs/loadSkills";
import { buildExampleInvocation } from "@/lib/docs/skill-example";
import { MCP_RELEASE_HOLD_CODE } from "@/lib/mcp-release-status";

interface PageProps {
  params: Promise<{ skill: string }>;
}

export const dynamic = "force-static";
export const dynamicParams = true;
export const revalidate = 86_400;

export function generateStaticParams(): [] {
  return [];
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { skill } = await params;
  const s = findSkillBySlug(skill);
  if (!s) return { title: "Skill not found · Moosewave docs" };
  return {
    title: `${s.name} · Release-held MCP source candidate`,
    description: `Release-held source definition for private evaluation only; no supported install, hosted connector, or working-key setup. ${s.description}`,
    alternates: { canonical: `/docs/skills/${s.slug}` },
  };
}

export default async function SkillPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const { skill } = await params;
  const s = findSkillBySlug(skill);
  if (!s) notFound();
  return (
    <article className="space-y-8">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "Skills", href: "/docs/skills" },
          { label: s.category, href: `/docs/skills#${s.category}` },
          { label: s.name },
        ]}
      />

      <header className="space-y-3">
        <div
          role="note"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Release-held source candidate ({MCP_RELEASE_HOLD_CODE}). This page
          documents mutable repository schema, not an installed or hosted tool.
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-pw-line bg-white px-2 py-0.5 capitalize">
            {s.category}
          </span>
          {s.hasCustomTimeout ? (
            <span className="rounded-full border border-amber-200 bg-amber-50 text-amber-800 px-2 py-0.5">
              long-running
            </span>
          ) : null}
        </div>
        <h1 className="break-all text-2xl font-semibold tracking-tight font-mono md:text-3xl">
          {s.name}
        </h1>
        <p className="text-pw-muted-on-paper leading-relaxed">
          {s.fullDescription}
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Input schema</h2>
        {s.inputFields.length === 0 ? (
          <p className="text-sm text-pw-muted-on-paper italic">
            No input arguments.
          </p>
        ) : (
          <div
            role="region"
            aria-label="Input schema"
            tabIndex={0}
            className="overflow-x-auto rounded-md border border-pw-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-sm">
              <thead className="bg-pw-surface">
                <tr className="text-left">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Field
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Required
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Description
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-pw-line">
                {s.inputFields.map((f) => (
                  <tr key={f.name}>
                    <td className="px-3 py-2 font-mono text-xs">{f.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-pw-muted-on-paper">
                      {f.kind}
                      {f.enumValues?.length
                        ? ` (${f.enumValues.join(" | ")})`
                        : ""}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {f.optional ? (
                        <span className="text-pw-muted-on-paper">optional</span>
                      ) : (
                        <span className="text-pw-ember-700 font-medium">
                          required
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-pw-muted-on-paper">
                      {f.description ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Example invocation</h2>
        <p className="text-sm text-pw-muted-on-paper">
          Non-executable source-schema illustration. MCP distribution is
          release-held ({MCP_RELEASE_HOLD_CODE}); the private source can be
          evaluated only without supported setup or governed-write guarantees.
          Do not paste this payload into a production client.
        </p>
        <CodeBlock
          code={buildExampleInvocation(s.name, s.inputFields)}
          language="json"
          caption="tools/call"
        />
      </section>

      <section className="text-xs text-pw-muted-on-paper border-t border-pw-line pt-3 space-y-1">
        <div>
          Source:{" "}
          <span className="break-all font-mono">
            packages/mcp-server/src/{s.source}
          </span>
        </div>
      </section>
    </article>
  );
}
