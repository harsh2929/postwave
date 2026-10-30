// SPDX-License-Identifier: AGPL-3.0-only
//
// Grouped settings navigation model shared by the desktop sidebar and the
// mobile tab selector (SETC-006, SETC-033). Groups the previously-flat 17-item
// list into labeled sections and provides active-tab resolution so the page
// header can reflect the current tab.

export interface SettingsNavItem {
  label: string;
  href: string;
}

export interface SettingsNavSection {
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_NAV_SECTIONS: readonly SettingsNavSection[] = [
  {
    label: "Account",
    items: [
      { label: "Workspace", href: "/app/settings" },
      { label: "Notifications", href: "/app/settings/notifications" },
      { label: "Team", href: "/app/settings/team" },
    ],
  },
  {
    label: "Sending",
    items: [
      { label: "Sender Identity", href: "/app/settings/sender" },
      { label: "Send-Time Optimization", href: "/app/settings/send-time" },
      { label: "Domain & DNS", href: "/app/settings/domain" },
      { label: "Custom Fields", href: "/app/settings/custom-fields" },
      { label: "Topics", href: "/app/settings/topics" },
    ],
  },
  {
    label: "Developer",
    items: [
      { label: "API Keys", href: "/app/settings/api" },
      { label: "Webhooks", href: "/app/settings/webhooks" },
      { label: "Integrations", href: "/app/settings/integrations" },
      { label: "Developer", href: "/app/settings/developer" },
      { label: "Offline Sync", href: "/app/settings/offline" },
    ],
  },
  {
    label: "Security & compliance",
    items: [
      { label: "Security", href: "/app/settings/security" },
      { label: "Audit Log", href: "/app/settings/audit" },
      { label: "Audit Streaming", href: "/app/settings/audit-sinks" },
      { label: "Data Region", href: "/app/settings/data-region" },
      { label: "Privacy", href: "/app/settings/privacy" },
    ],
  },
] as const;

/** Flat list of every nav item, in section order. */
export function flattenSettingsNav(): SettingsNavItem[] {
  return SETTINGS_NAV_SECTIONS.flatMap((section) => section.items);
}

/** True when `href` is the active tab for the given pathname. The Workspace
 * index (`/app/settings`) matches only its exact path; every other tab matches
 * its path or any nested route under it. */
export function isActiveSettingsTab(href: string, pathname: string): boolean {
  if (href === "/app/settings") return pathname === "/app/settings";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The active nav item for a pathname (longest matching href wins so nested
 * routes resolve to their tab, not the index). Returns null when nothing
 * matches. */
export function activeSettingsItem(pathname: string): SettingsNavItem | null {
  let best: SettingsNavItem | null = null;
  for (const item of flattenSettingsNav()) {
    if (!isActiveSettingsTab(item.href, pathname)) continue;
    if (!best || item.href.length > best.href.length) best = item;
  }
  return best;
}

/** Human title for the active tab, for the settings page header. */
export function activeSettingsLabel(pathname: string): string {
  return activeSettingsItem(pathname)?.label ?? "Settings";
}
