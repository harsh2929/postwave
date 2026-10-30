"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// The console's single global navigation surface: a sticky app bar rendered once
// in the root layout so every view shares it and no page is a dead-end. Active
// state is derived from the pathname (exact for the board, prefix for sections).
import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Board" },
  { href: "/tenants", label: "Tenants" },
  { href: "/send", label: "Send" },
  { href: "/deliverability", label: "Deliverability" },
  { href: "/campaign-assurance", label: "Assurance" },
  { href: "/billing", label: "Billing" },
  { href: "/incidents", label: "Incidents" },
  { href: "/launch", label: "Launch" },
];

function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export default function AppBar() {
  const pathname = usePathname() ?? "/";
  return (
    <header className="appbar">
      <Link href="/" className="appbar__brand" aria-label="Moosewave Ops home">
        <span className="appbar__dot" aria-hidden="true" />
        POSTWAVE&nbsp;<span style={{ color: "var(--text-3)", fontWeight: 500 }}>OPS</span>
      </Link>
      <nav className="appbar__nav" aria-label="Ops console">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="navlink"
            aria-current={isActive(s.href, pathname) ? "page" : undefined}
          >
            {s.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
