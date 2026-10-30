// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The actionable fix on one deliverability-hub breach row. Desktop parity:
 * components/deliverability/ActionCenter.tsx act() (75-83) and its href /
 * button branches (119-135).
 *
 * The hub already serialises `breaches[].fix_cta = {label, section?, href?}`
 * (apps/api/internal/deliverability_hub/hub.go ThresholdBreach.FixCTA). Its
 * `section` values are DESKTOP section ids, so they are translated to web
 * routes here — through the shared @postwave/nav manifest wherever that
 * manifest names the section, never by guessing a path from the id:
 *
 *   suppressions      → routeFor("suppressions", "web")
 *   campaigns         → routeFor("campaigns", "web")
 *   sequences         → routeFor("sequences", "web")
 *   deliverabilityHub → routeFor("deliverabilityHub", "web") + "#dh-blocklist"
 *                       (desktop opens the hub's own evidence panel; on web
 *                       that is the Blocklist hits section of this page)
 *   domains           → /app/settings/sender. The breach behind it
 *                       (`dns_broken`) is SPF/DKIM/DMARC on sending
 *                       identities, which web manages on Sender Identity; the
 *                       custom-domain page itself points operators there.
 *
 * An `href` is honoured only when it is an absolute https URL and opens in a
 * new tab; anything else (javascript:, http:, relative) is not rendered as a
 * link. A section with no web destination renders a disabled control that
 * says so, rather than a button that silently does nothing.
 */
import Link from "next/link";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { routeFor } from "@postwave/nav";

import { Button } from "@/components/ui/button";
import { asRoute } from "@/lib/typed-routes";

export interface BreachFixCtaWire {
  label: string;
  section?: string;
  href?: string;
}

export type BreachFixDestination =
  | { kind: "internal"; href: string; label: string }
  | { kind: "external"; href: string; label: string }
  | { kind: "unmapped"; label: string; section: string };

function navRoute(key: string, suffix = ""): string | null {
  const route = routeFor(key, "web");
  return route ? `${route}${suffix}` : null;
}

/** Desktop section id → web route. Unknown ids are deliberately absent. */
export function webRouteForHubSection(section: string): string | null {
  switch (section) {
    case "suppressions":
    case "campaigns":
    case "sequences":
      return navRoute(section);
    case "deliverabilityHub":
      return navRoute("deliverabilityHub", "#dh-blocklist");
    case "domains":
      return "/app/settings/sender";
    default:
      return null;
  }
}

function parseFixCta(value: unknown): BreachFixCtaWire | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const label = typeof row.label === "string" ? row.label.trim() : "";
  if (!label || label.length > 120) return null;
  return {
    label,
    ...(typeof row.section === "string" && row.section.trim()
      ? { section: row.section.trim() }
      : {}),
    ...(typeof row.href === "string" && row.href.trim()
      ? { href: row.href.trim() }
      : {}),
  };
}

function safeExternalHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

export function breachFixDestination(
  fixCta: unknown,
): BreachFixDestination | null {
  const cta = parseFixCta(fixCta);
  if (!cta) return null;
  if (cta.href) {
    const external = safeExternalHref(cta.href);
    if (external) return { kind: "external", href: external, label: cta.label };
  }
  if (cta.section) {
    const route = webRouteForHubSection(cta.section);
    return route
      ? { kind: "internal", href: route, label: cta.label }
      : { kind: "unmapped", label: cta.label, section: cta.section };
  }
  return null;
}

export function BreachFixCta({
  breach,
}: {
  breach: { code: string; fix_cta?: unknown };
}) {
  const destination = breachFixDestination(breach.fix_cta);
  if (!destination) return null;
  if (destination.kind === "external") {
    return (
      <Button asChild size="sm" variant="outline" className="mt-1.5">
        <a href={destination.href} target="_blank" rel="noopener noreferrer">
          {destination.label}
          <ArrowUpRight aria-hidden />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </Button>
    );
  }
  if (destination.kind === "internal") {
    return (
      <Button asChild size="sm" variant="outline" className="mt-1.5">
        <Link href={asRoute(destination.href)}>
          {destination.label}
          <ChevronRight aria-hidden />
        </Link>
      </Button>
    );
  }
  const reasonId = `breach-fix-${breach.code}-reason`;
  return (
    <span className="mt-1.5 inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled
        aria-describedby={reasonId}
      >
        {destination.label}
      </Button>
      <span id={reasonId} className="text-xs text-muted-foreground">
        This fix has no web destination yet.
      </span>
    </span>
  );
}
