// SPDX-License-Identifier: AGPL-3.0-only
//
// Client source catalogue: search + ESP/CRM/File grouping over the 20-source
// grid (MIGR-020), clamped card descriptions with an expander (MIGR-008),
// capability checklists collapsed on mobile so the list is scannable (MIGR-009),
// a per-source docs "Guide" link (MIGR-017), and a connection-type-aware CTA
// verb — "Upload" for file sources, "Connect" otherwise (MIGR-030).
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, Search, X } from "lucide-react";

import {
  migrationAutomationCapabilityLabel,
  migrationCapabilityDescription,
  migrationAvailabilityDescription,
} from "@/lib/migration-capability-copy";
import { migrationDocsHref } from "@/lib/migration-docs";
import {
  filterCapabilities,
  groupCapabilities,
  migrationSourceCtaVerb,
} from "@/lib/migration-source-catalog";
import { SOURCE_LABELS, type AdapterCapabilities } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function SourceCatalog({
  capabilities,
  authorityKey,
  canAdmin,
}: {
  capabilities: AdapterCapabilities[];
  authorityKey: string;
  canAdmin: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(
    () => groupCapabilities(filterCapabilities(capabilities, query)),
    [capabilities, query],
  );
  const total = groups.reduce((n, g) => n + g.caps.length, 0);

  useEffect(() => {
    setQuery("");
  }, [authorityKey]);

  if (!canAdmin) return null;

  return (
    <div
      id="source-grid"
      data-testid="migration-source-picker"
      className="space-y-5 scroll-mt-24"
    >
      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={searchRef}
          type="search"
          aria-label="Search migration sources"
          placeholder="Search sources…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`h-11 pl-8 sm:h-9 ${query ? "pr-11" : ""}`}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear migration source search"
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
            className="absolute right-0 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:size-9"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {total} migration source{total === 1 ? "" : "s"} shown
      </p>

      {total === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground [overflow-wrap:anywhere]">
          No sources match “{query.trim()}”.
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.category} className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.caps.map((cap) => (
                <SourceCard key={cap.source} cap={cap} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function SourceCard({ cap }: { cap: AdapterCapabilities }) {
  const [descOpen, setDescOpen] = useState(false);
  const [capsOpen, setCapsOpen] = useState(false);
  const supports = cap.supports;
  const showMailchimpParity = cap.source === "mailchimp";
  const automationLabel = migrationAutomationCapabilityLabel(cap);
  const description = migrationCapabilityDescription(cap);
  const ctaVerb = migrationSourceCtaVerb(cap);
  const docsHref = migrationDocsHref(cap.source);
  const titleId = `migration-source-${cap.source}-title`;
  const descriptionId = `migration-source-${cap.source}-description`;
  const capabilitiesId = `migration-source-${cap.source}-capabilities`;
  const availabilityId = `migration-source-${cap.source}-availability`;
  const availability = migrationAvailabilityDescription(cap);

  const items: Array<[string, boolean]> = [
    ["Subscribers", supports.subscribers],
    ["Segments", supports.segments],
    [automationLabel, supports.automations],
    ...(showMailchimpParity
      ? ([["Customer Journeys (manual rebuild)", false]] satisfies Array<
          [string, boolean]
        >)
      : []),
    ["Archive", supports.campaign_archive],
    ...(showMailchimpParity
      ? ([
          ["Templates", supports.templates === true],
          ["Forms", supports.forms === true],
          ["Landing pages", supports.landing_pages === true],
          ["Reports", supports.reports === true],
          ["Ecommerce", supports.ecommerce === true],
        ] satisfies Array<[string, boolean]>)
      : []),
    ["Paid subs", supports.paid_subs],
  ];

  return (
    <Card
      aria-labelledby={titleId}
      className="group flex min-w-0 flex-col overflow-hidden rounded-xl transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-pw-md motion-reduce:hover:translate-y-0"
    >
      <CardHeader className="p-4 pb-3 sm:p-5 sm:pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle as="h4" id={titleId} className="min-w-0 text-base">
            {SOURCE_LABELS[cap.source]}
          </CardTitle>
          <Badge variant="outline" className="shrink-0 font-normal">
            {authLabel(cap)}
          </Badge>
        </div>
        <CardDescription
          id={descriptionId}
          className={descOpen ? "text-xs" : "text-xs line-clamp-3"}
        >
          {description}
        </CardDescription>
        <div className="flex items-center gap-3 pt-0.5">
          <button
            type="button"
            onClick={() => setDescOpen((v) => !v)}
            aria-expanded={descOpen}
            aria-controls={descriptionId}
            aria-label={`${SOURCE_LABELS[cap.source]} ${descOpen ? "show less" : "details"}`}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-8 sm:min-w-0"
          >
            {descOpen ? "Show less" : "Details"}
          </button>
          <Link
            href={docsHref}
            aria-label={`${SOURCE_LABELS[cap.source]} migration guide`}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-8 sm:min-w-0"
          >
            <BookOpen className="h-3 w-3" aria-hidden="true" /> Guide
          </Link>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 p-4 pt-0 sm:p-5 sm:pt-0">
        {/* Capabilities: collapsed by default on mobile so the picker stays
            scannable (MIGR-009); always shown from `sm` up. */}
        <button
          type="button"
          onClick={() => setCapsOpen((v) => !v)}
          aria-expanded={capsOpen}
          aria-controls={capabilitiesId}
          aria-label={`${SOURCE_LABELS[cap.source]} capabilities`}
          className="flex min-h-11 items-center justify-between rounded-md text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:hidden"
        >
          <span>Capabilities</span>
          <span aria-hidden>{capsOpen ? "−" : "+"}</span>
        </button>
        <ul
          id={capabilitiesId}
          className={`${capsOpen ? "block" : "hidden"} space-y-1.5 sm:block`}
        >
          {items.map(([label, ok]) => (
            <li key={label} className="flex items-center gap-2 text-xs">
              {ok ? (
                <Check
                  className="h-3.5 w-3.5 text-success"
                  aria-hidden="true"
                />
              ) : (
                <X
                  className="h-3.5 w-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span className="sr-only">
                {ok ? "Supported: " : "Not supported: "}
              </span>
              <span className={ok ? "" : "text-muted-foreground line-through"}>
                {label}
              </span>
            </li>
          ))}
        </ul>
        {availability && (
          <p id={availabilityId} className="text-xs text-muted-foreground">
            {availability}
          </p>
        )}
        {cap.intake_available === false ? (
          <Button
            size="sm"
            disabled
            aria-describedby={availabilityId}
            className="mt-auto min-h-11 w-full sm:min-h-9"
          >
            {cap.auth_method === "csv_upload"
              ? "Upload unavailable"
              : "Connection unavailable"}
          </Button>
        ) : (
          <Button
            asChild
            size="sm"
            className="mt-auto min-h-11 w-full sm:min-h-9"
          >
            <Link
              href={`/app/migrations/new/${cap.source}`}
              data-testid={`source-${cap.source}`}
              aria-label={`${ctaVerb} ${SOURCE_LABELS[cap.source]} migration`}
            >
              {ctaVerb}{" "}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function authLabel(cap: AdapterCapabilities): string {
  if (cap.source === "activecampaign") return "API token";
  if (cap.source === "hubspot") return "Service Key / token";
  if (cap.source === "klaviyo") return "Private API key";
  if (cap.source === "customerio") return "App API key";
  switch (cap.auth_method) {
    case "oauth2":
      return "OAuth";
    case "api_key":
      return "API key";
    case "csv_upload":
      return "CSV upload";
  }
}
