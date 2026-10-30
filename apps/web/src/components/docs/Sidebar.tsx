// Moosewave docs - collapsible sidebar navigation tree.
//
// Three top-level sections: Get Started, API, Guides. Each section renders
// a list of links and (for API) a nested tree grouped by tag, expanded on
// the route the user is currently viewing. The component is a Client
// Component because we need pathname access and the on-page expand/collapse
// state. Mobile: shown via a Radix Dialog with the same content.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";

import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";
import { useDocsNav } from "./docs-nav-context";

const GET_STARTED_LINKS: { href: string; label: string }[] = [
  { href: "/docs/getting-started", label: "Overview" },
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/getting-started#authentication", label: "Authentication" },
  { href: "/docs/getting-started#concepts", label: "Concepts" },
];

function SectionHeader({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  // A heading, not a styled div. This sidebar is one nav landmark holding
  // several hundred links — every API endpoint and every skill — and its four
  // sections (Get Started, API, Skills by category, Guides) were the only
  // thing separating them. Rendered as divs they exist for sighted readers
  // only, leaving anyone navigating by heading or landmark with a single
  // undifferentiated run of links and no way to reach "Guides".
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-pw-muted-on-paper px-3 mt-6 mb-2">
      {children}
    </h2>
  );
}

function NavLink({
  href,
  label,
  active,
  prefix,
}: {
  href: string;
  label: React.ReactNode;
  active: boolean;
  prefix?: React.ReactNode;
}): JSX.Element {
  return (
    <Link
      href={asRoute(href)}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 lg:min-h-8",
        active
          ? "bg-pw-ember-500/10 text-pw-ember-700 font-medium"
          : "text-pw-muted-on-paper hover:bg-pw-surface hover:text-pw-ink2",
      )}
    >
      {prefix}
      <span className="truncate">{label}</span>
    </Link>
  );
}

const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-700 bg-emerald-50 border-emerald-200",
  POST: "text-blue-700 bg-blue-50 border-blue-200",
  PUT: "text-amber-700 bg-amber-50 border-amber-200",
  PATCH: "text-orange-700 bg-orange-50 border-orange-200",
  DELETE: "text-red-700 bg-red-50 border-red-200",
};

function MethodBadge({ method }: { method: string }): JSX.Element {
  const m = method.toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-sm border px-1 text-[9px] font-mono font-bold leading-4 w-10 flex-none",
        METHOD_COLORS[m] ??
          "text-pw-muted-on-paper bg-pw-surface border-pw-line",
      )}
    >
      {m}
    </span>
  );
}

function CollapsibleGroup({
  label,
  count,
  children,
  defaultOpen,
  forceOpen = false,
  onExpand,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  defaultOpen: boolean;
  // When the sidebar is being filtered, groups expand so matches are visible
  // without collapsing the user's own toggle state once the filter clears.
  forceOpen?: boolean;
  // Fired whenever this group becomes visible. The layout only inlines group
  // names and counts (RSC-01), so expanding is the moment the item-level index
  // is actually needed.
  onExpand?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const expanded = open || forceOpen;
  useEffect(() => {
    if (expanded) onExpand?.();
  }, [expanded, onExpand]);
  // While `forceOpen` holds, the filter owns the expansion and this toggle
  // cannot collapse anything — pressing it changes nothing on screen. A
  // control that reports aria-expanded while being inert tells a screen-reader
  // user it operates something it does not, so say it is disabled and why.
  // aria-disabled rather than `disabled` keeps it focusable, so the reason is
  // reachable instead of silently skipped in the tab order.
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => {
          if (forceOpen) return;
          setOpen((s) => !s);
        }}
        className={cn(
          "flex min-h-11 w-full items-center justify-between rounded-md px-3 py-1.5 text-sm font-medium text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 lg:min-h-8",
          forceOpen ? "cursor-default opacity-70" : "hover:bg-pw-surface",
        )}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-disabled={forceOpen || undefined}
        title={
          forceOpen
            ? "Expanded while the filter is active — clear the filter to collapse"
            : undefined
        }
      >
        <span className="truncate">{label}</span>
        <span className="text-[10px] font-mono text-pw-muted-on-paper tabular-nums">
          {count}
        </span>
      </button>
      {expanded ? (
        <div id={panelId} className="mt-0.5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown inside an expanded group whose items have not arrived yet. Announced,
 * because expanding a group and getting an empty box reads as an error.
 */
function PendingItems({ label }: { label: string }): JSX.Element {
  return (
    <p
      role="status"
      className="ml-1 border-l border-pw-line pl-3 py-1 text-xs text-pw-muted-on-paper"
    >
      {label}…
    </p>
  );
}

/** Item count, from the summary's `count` or from the loaded items. */
function groupCount(g: { count?: number; items?: unknown[] }): number {
  return g.count ?? g.items?.length ?? 0;
}

export function Sidebar(): JSX.Element {
  const { nav, indexLoaded, loadIndex } = useDocsNav();
  const { apiGroups, skillGroups, migrationSources, integrations } = nav;
  const pathname = usePathname() ?? "";
  const [filter, setFilter] = useState("");

  // On an endpoint or skill page the tree has to know which group holds the
  // current slug in order to open it. That needs item-level data, so fetch it
  // — but at idle, so the ~28 KB (gzip) request never competes with hydration.
  const needsIndexForActiveGroup =
    pathname.startsWith("/docs/api/") || pathname.startsWith("/docs/skills/");
  useEffect(() => {
    if (indexLoaded || !needsIndexForActiveGroup) return;
    const idle = (
      globalThis as {
        requestIdleCallback?: (cb: () => void) => number;
      }
    ).requestIdleCallback;
    if (idle) {
      idle(loadIndex);
      return;
    }
    const t = setTimeout(loadIndex, 200);
    return () => clearTimeout(t);
  }, [indexLoaded, needsIndexForActiveGroup, loadIndex]);

  // Open the API tag group containing the current endpoint.
  const activeApiTag = useMemo(() => {
    if (!pathname.startsWith("/docs/api/")) return null;
    const slug = pathname.slice("/docs/api/".length);
    for (const g of apiGroups) {
      if (g.items?.some((it) => it.slug === slug)) return g.tag;
    }
    return null;
  }, [pathname, apiGroups]);

  const activeSkillCat = useMemo(() => {
    if (!pathname.startsWith("/docs/skills/")) return null;
    const slug = pathname.slice("/docs/skills/".length);
    for (const g of skillGroups) {
      if (g.items?.some((it) => it.slug === slug)) return g.category;
    }
    return null;
  }, [pathname, skillGroups]);

  // MKTN-009: client-side filter over the already-loaded nav data. A matching
  // group heading keeps all its items; otherwise only the matching items show.
  const q = filter.trim().toLowerCase();
  const filtering = q.length > 0;
  const matches = (s: string): boolean => s.toLowerCase().includes(q);

  const getStartedLinks = filtering
    ? GET_STARTED_LINKS.filter((l) => matches(l.label))
    : GET_STARTED_LINKS;

  const filteredApiGroups = useMemo(() => {
    if (!filtering) return apiGroups;
    const out: typeof apiGroups = [];
    for (const g of apiGroups) {
      if (g.tag.toLowerCase().includes(q)) {
        out.push(g);
        continue;
      }
      const items = (Array.isArray(g.items) ? g.items : []).filter(
        (it) =>
          it.path.toLowerCase().includes(q) ||
          it.method.toLowerCase().includes(q),
      );
      if (items.length > 0) out.push({ ...g, items });
    }
    return out;
  }, [apiGroups, filtering, q]);

  const filteredSkillGroups = useMemo(() => {
    if (!filtering) return skillGroups;
    const out: typeof skillGroups = [];
    for (const g of skillGroups) {
      if (g.category.toLowerCase().includes(q)) {
        out.push(g);
        continue;
      }
      const items = (Array.isArray(g.items) ? g.items : []).filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.slug.toLowerCase().includes(q),
      );
      if (items.length > 0) out.push({ ...g, items });
    }
    return out;
  }, [skillGroups, filtering, q]);

  const filteredMigrations = filtering
    ? migrationSources.filter((m) => matches(m.name))
    : migrationSources;
  const filteredIntegrations = filtering
    ? integrations.filter((m) => matches(m.name))
    : integrations;

  const showApiOverview = !filtering || matches("API overview");
  const showSkillsMcp = !filtering || matches("Skills (MCP)");
  const showMigrationsLink = !filtering || matches("Migrations");
  const showIntegrationsLink = !filtering || matches("Integrations");
  const showChangelogLink = !filtering || matches("Changelog");

  const showGetStarted = !filtering || getStartedLinks.length > 0;
  const showApiSection =
    !filtering ||
    showApiOverview ||
    showSkillsMcp ||
    filteredApiGroups.length > 0;
  const showSkillsSection = !filtering || filteredSkillGroups.length > 0;
  const showGuides =
    !filtering ||
    showMigrationsLink ||
    showIntegrationsLink ||
    showChangelogLink ||
    filteredMigrations.length > 0 ||
    filteredIntegrations.length > 0;

  const hasAnyResult =
    getStartedLinks.length > 0 ||
    matches("API overview") ||
    matches("Skills (MCP)") ||
    filteredApiGroups.length > 0 ||
    filteredSkillGroups.length > 0 ||
    matches("Migrations") ||
    matches("Integrations") ||
    matches("Changelog") ||
    filteredMigrations.length > 0 ||
    filteredIntegrations.length > 0;

  return (
    <nav aria-label="Documentation sidebar" className="space-y-1 text-sm">
      <div className="relative mb-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => {
            // Item-level matches need the full index; the layout only inlined
            // group names and counts (RSC-01).
            if (e.target.value.trim()) loadIndex();
            setFilter(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              e.preventDefault();
              setFilter("");
            }
          }}
          placeholder="Filter navigation…"
          aria-label="Filter documentation navigation"
          className="h-11 w-full rounded-md border border-pw-line bg-white py-1.5 pl-3 pr-11 text-base text-pw-ink2 outline-none placeholder:text-pw-muted-on-paper focus-visible:border-pw-ember-500 focus-visible:ring-2 focus-visible:ring-pw-ember-500 lg:h-9 lg:text-sm"
        />
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter("")}
            aria-label="Clear filter"
            className="absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded text-pw-muted-on-paper hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 lg:h-9 lg:w-9"
          >
            <svg
              aria-hidden
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        ) : null}
      </div>

      {filtering && !hasAnyResult ? (
        <p
          className="px-3 py-6 text-center text-sm text-pw-muted-on-paper"
          role={indexLoaded ? undefined : "status"}
        >
          {indexLoaded ? (
            <>
              No matches for{" "}
              <span className="font-mono text-pw-ink2">{filter}</span>
            </>
          ) : (
            <>Searching endpoints and skills…</>
          )}
        </p>
      ) : null}

      {showGetStarted ? <SectionHeader>Get Started</SectionHeader> : null}
      {showGetStarted ? (
        <div className="space-y-0.5">
          {getStartedLinks.map((l) => (
            <NavLink
              key={l.href}
              href={l.href}
              label={l.label}
              // MKTN-005: hash sub-links are anchors, never route-active — only
              // a hash-free href that equals the current path lights the pill,
              // so exactly one Get-Started row is active per page.
              active={!l.href.includes("#") && pathname === l.href}
            />
          ))}
        </div>
      ) : null}

      {showApiSection ? <SectionHeader>API</SectionHeader> : null}
      {showApiSection ? (
        <div className="space-y-0.5">
          {showApiOverview ? (
            <NavLink
              href="/docs/api"
              label="API overview"
              active={pathname === "/docs/api"}
            />
          ) : null}
          {showSkillsMcp ? (
            <NavLink
              href="/docs/skills"
              label="MCP source catalogue (held)"
              active={pathname === "/docs/skills"}
            />
          ) : null}
        </div>
      ) : null}

      {showApiSection ? (
        <div className="mt-2 space-y-0.5">
          {filteredApiGroups.map((g) => (
            <CollapsibleGroup
              key={g.tag}
              label={g.tag}
              count={groupCount(g)}
              defaultOpen={g.tag === activeApiTag}
              forceOpen={filtering}
              onExpand={loadIndex}
            >
              {g.items ? (
                <ul className="ml-1 border-l border-pw-line pl-2 py-0.5 space-y-0.5">
                  {g.items.map((it) => {
                    const href = `/docs/api/${it.slug}`;
                    return (
                      <li key={it.slug}>
                        <NavLink
                          href={href}
                          active={pathname === href}
                          prefix={<MethodBadge method={it.method} />}
                          label={
                            <span className="font-mono text-[11px]">
                              {it.path}
                            </span>
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <PendingItems label={`Loading ${g.tag} endpoints`} />
              )}
            </CollapsibleGroup>
          ))}
        </div>
      ) : null}

      {showSkillsSection ? (
        <SectionHeader>Skills by category</SectionHeader>
      ) : null}
      {showSkillsSection ? (
        <div className="space-y-0.5">
          {filteredSkillGroups.map((g) => (
            <CollapsibleGroup
              key={g.category}
              label={g.category}
              count={groupCount(g)}
              defaultOpen={g.category === activeSkillCat}
              forceOpen={filtering}
              onExpand={loadIndex}
            >
              {g.items ? (
                <ul className="ml-1 border-l border-pw-line pl-2 py-0.5 space-y-0.5">
                  {g.items.map((it) => {
                    const href = `/docs/skills/${it.slug}`;
                    return (
                      <li key={it.slug}>
                        <NavLink
                          href={href}
                          active={pathname === href}
                          label={
                            <span className="font-mono text-[11px]">
                              {it.name}
                            </span>
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <PendingItems label={`Loading ${g.category} skills`} />
              )}
            </CollapsibleGroup>
          ))}
        </div>
      ) : null}

      {showGuides ? <SectionHeader>Guides</SectionHeader> : null}
      {showGuides ? (
        <div className="space-y-0.5">
          {showMigrationsLink ? (
            <NavLink
              href="/docs/migrations"
              label="Migrations"
              active={pathname === "/docs/migrations"}
            />
          ) : null}
          {filteredMigrations.length > 0 ? (
            <ul className="ml-1 border-l border-pw-line pl-2 py-0.5 space-y-0.5">
              {filteredMigrations.map((m) => {
                const href = `/docs/migrations/${m.slug}`;
                return (
                  <li key={m.slug}>
                    <NavLink
                      href={href}
                      label={m.name}
                      active={pathname === href}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}
          {showIntegrationsLink ? (
            <NavLink
              href="/docs/integrations"
              label="Integrations"
              active={pathname === "/docs/integrations"}
            />
          ) : null}
          {filteredIntegrations.length > 0 ? (
            <ul className="ml-1 border-l border-pw-line pl-2 py-0.5 space-y-0.5">
              {filteredIntegrations.map((m) => {
                const href = `/docs/integrations/${m.slug}`;
                return (
                  <li key={m.slug}>
                    <NavLink
                      href={href}
                      label={m.name}
                      active={pathname === href}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}
          {showChangelogLink ? (
            <NavLink
              href="/docs/changelog"
              label="Changelog"
              active={pathname === "/docs/changelog"}
            />
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
