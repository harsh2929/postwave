// SPDX-License-Identifier: AGPL-3.0-only
//
// Product mega-menu for the marketing header. Client component: it owns the
// open/close disclosure state, keyboard handling (Esc), and click-outside.
// The grouped link map is the authoritative IA — every entry resolves to a
// real route or an in-page anchor of a capability page (no dead links).
"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { asRoute } from "@/lib/typed-routes";

type MenuLink = { href: string; label: string; desc: string };
type MenuGroup = { heading: string; links: MenuLink[] };

const GROUPS: MenuGroup[] = [
  {
    heading: "Move & Land",
    links: [
      {
        href: "/migrations",
        label: "Migration",
        desc: "Import with a dry-run report",
      },
      {
        href: "/deliverability",
        label: "Deliverability",
        desc: "Controlled-inbox placement + AI diagnostician",
      },
      {
        href: "/deliverability#domains",
        label: "Domains & Sending",
        desc: "Custom domains, DNS health, warmup",
      },
    ],
  },
  {
    heading: "Create",
    links: [
      { href: "/voice", label: "Voice AI", desc: "Sequences in your voice" },
      {
        href: "/features#editor",
        label: "Editor",
        desc: "Block + markdown, MJML",
      },
      {
        href: "/features#archive",
        label: "Archive",
        desc: "Public archive + deterministic remix drafts",
      },
    ],
  },
  {
    heading: "Grow",
    links: [
      {
        href: "/audiences",
        label: "Audiences & Ad Sync",
        desc: "Meta, Google, TikTok, LinkedIn, Snap",
      },
      {
        href: "/forms",
        label: "Forms",
        desc: "Multi-step embeddable signup forms",
      },
      {
        href: "/landing-pages",
        label: "Landing pages",
        desc: "Reserve slugs and plan pages",
      },
      { href: "/sms", label: "SMS", desc: "10DLC, consent, campaigns" },
      {
        href: "/audiences#referrals",
        label: "Referral history",
        desc: "Historical stats; operations held",
      },
    ],
  },
  {
    heading: "Automate",
    links: [
      {
        href: "/automations",
        label: "Automations",
        desc: "Visual flow builder + triggers",
      },
      {
        href: "/audiences#segments",
        label: "Segments",
        desc: "Dynamic audience builder",
      },
      {
        href: "/analytics",
        label: "Goals & Analytics",
        desc: "Pacing, reports, cohorts",
      },
    ],
  },
  {
    heading: "Monetize",
    links: [
      {
        href: "/commerce",
        label: "Commerce",
        desc: "Shopify, BigCommerce, PayPal…",
      },
      {
        href: "/commerce#subscriptions",
        label: "Subscription history",
        desc: "Read-only lifecycle evidence",
      },
      {
        href: "/podcasts",
        label: "Podcasts",
        desc: "Private tier-gated audio",
      },
    ],
  },
  {
    heading: "Build",
    links: [
      {
        href: "/developers",
        label: "Developer Platform",
        desc: "Marketplace, OAuth, webhooks",
      },
      {
        href: "/mcp",
        label: "MCP source candidate",
        desc: "Release held · catalogue only",
      },
      { href: "/api-docs", label: "API", desc: "OpenAPI 3.1 + SDKs" },
    ],
  },
];

export function ProductMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointer(e: MouseEvent): void {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-11 items-center gap-1 rounded px-1 transition-colors hover:text-pw-ink2 focus-visible:outline-none focus-visible:text-pw-ink2 focus-visible:ring-2 focus-visible:ring-pw-ember-500"
      >
        Product
        <span
          aria-hidden
          className={`text-[10px] transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {open ? (
        <nav
          id={panelId}
          aria-labelledby={triggerId}
          className="fixed left-1/2 top-14 z-50 mt-3 max-h-[calc(100dvh-4.25rem)] w-[min(calc(100vw_-_2rem),52rem)] -translate-x-1/2 overflow-y-auto overscroll-contain rounded-xl border border-pw-surface bg-pw-paper p-5 shadow-lg"
        >
          <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {GROUPS.map((group) => (
              <div key={group.heading}>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-pw-muted-on-paper">
                  {group.heading}
                </div>
                <ul className="space-y-1">
                  {group.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={asRoute(link.href)}
                        onClick={() => setOpen(false)}
                        className="flex min-h-11 flex-col justify-center rounded-md px-2 py-1.5 transition-colors hover:bg-pw-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                      >
                        <span className="block text-sm font-medium text-pw-ink2">
                          {link.label}
                        </span>
                        <span className="block text-xs text-pw-muted-on-paper">
                          {link.desc}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
