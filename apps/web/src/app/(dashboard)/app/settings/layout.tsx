// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type MouseEvent, type ReactNode } from "react";

import {
  UnsavedChangesProvider,
  useUnsavedChanges,
} from "@/components/settings/unsaved-changes";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  SETTINGS_NAV_SECTIONS,
  activeSettingsLabel,
  flattenSettingsNav,
  isActiveSettingsTab,
} from "@/lib/settings-nav";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <UnsavedChangesProvider>
      <SettingsShell>{children}</SettingsShell>
    </UnsavedChangesProvider>
  );
}

function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { confirmDiscard } = useUnsavedChanges();
  const activeLabel = activeSettingsLabel(pathname);
  const activeHref =
    flattenSettingsNav().find((i) => isActiveSettingsTab(i.href, pathname))
      ?.href ?? "/app/settings";

  useEffect(() => {
    document.title = `${activeLabel} settings | Moosewave`;
  }, [activeLabel]);

  // Guard every navigation away from a dirty form (SETC-001). Anchors keep
  // prefetch + a11y; we just cancel the default when the user backs out.
  const guardLink = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!confirmDiscard()) event.preventDefault();
  };

  const onMobileSelect = (href: string) => {
    if (href === pathname) return;
    if (confirmDiscard()) router.push(asRoute(href));
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Settings
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {activeLabel}
        </h1>
      </header>

      {/* Mobile: a compact selector instead of a 17-item stack (SETC-006). */}
      <div className="mb-6 md:hidden">
        <Label htmlFor="settings-nav-select" className="sr-only">
          Settings section
        </Label>
        <Select
          id="settings-nav-select"
          value={activeHref}
          onChange={(e) => onMobileSelect(e.target.value)}
        >
          {SETTINGS_NAV_SECTIONS.map((section) => (
            <optgroup key={section.label} label={section.label}>
              {section.items.map((item) => (
                <option key={item.href} value={item.href}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[12.5rem_minmax(0,1fr)] md:gap-8 xl:grid-cols-[14rem_minmax(0,1fr)]">
        {/* Desktop: grouped, labeled sections (SETC-033). */}
        <nav
          aria-label="Settings sections"
          className="hidden flex-col gap-5 text-sm md:sticky md:top-6 md:flex md:max-h-[calc(100dvh-10rem)] md:overflow-y-auto md:overscroll-contain md:pr-1"
        >
          {SETTINGS_NAV_SECTIONS.map((section) => (
            <div key={section.label} className="flex flex-col gap-1">
              {/* Full-opacity muted, not /70: the 70% alpha blends to #8b8b89
                  on the settings surface, which is 3.21:1 — below the 4.5:1
                  WCAG AA floor for 12px text. These are the section names of
                  the settings nav, so they have to be readable. */}
              <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.label}
              </p>
              {section.items.map((item) => {
                const active = isActiveSettingsTab(item.href, pathname);
                return (
                  <Link
                    key={item.href}
                    href={asRoute(item.href)}
                    onClick={guardLink}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-10 items-center rounded-md px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [@media(pointer:coarse)]:min-h-11",
                      active
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
