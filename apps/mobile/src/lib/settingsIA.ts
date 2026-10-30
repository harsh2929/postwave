/**
 * lib/settingsIA.ts — the Settings screen's information architecture.
 *
 * Settings is a ~800-line linear scroll of 20+ sections with no index, no
 * search and no jump. Finding "App lock" means thumb-scrolling past API
 * connection, Appearance, Push and Privacy every single time — and unlike
 * desktop, a phone has no ⌘F. Desktop has shipped SettingsNavigationIndex,
 * backed by a 35-anchor IA, for a long time.
 *
 * This is the mobile half: one declaration of what sections exist, what
 * category each belongs to, and what a user might plausibly type when looking
 * for it. Import-free so the matcher is unit-tested in the node environment.
 *
 * KEYWORDS ARE THE POINT. People search for the word in their head, not the
 * heading we chose: "face id" for App lock, "2fa" for two-factor, "gdpr" for
 * privacy requests, "dark mode" for Appearance. A label-only matcher looks
 * like search and behaves like a table of contents.
 */

export type SettingsCategory =
  | "Account"
  | "Device"
  | "Privacy"
  | "Workspace";

export interface SettingsAnchor {
  /** Matches the `anchor` prop on the section's SectionHeader. */
  key: string;
  label: string;
  category: SettingsCategory;
  keywords: readonly string[];
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  "Account",
  "Device",
  "Privacy",
  "Workspace",
];

export const SETTINGS_ANCHORS: readonly SettingsAnchor[] = [
  {
    key: "account",
    label: "Account",
    category: "Account",
    keywords: ["email", "role", "workspace", "sign in", "identity", "profile"],
  },
  {
    key: "security",
    label: "Two-factor and devices",
    category: "Account",
    keywords: ["2fa", "totp", "mfa", "authenticator", "sessions", "devices", "sign out everywhere"],
  },
  {
    key: "viewer-preview",
    label: "Viewer preview",
    category: "Account",
    keywords: ["view as", "read only", "preview", "impersonate", "permissions"],
  },
  {
    key: "api-connection",
    label: "API connection",
    category: "Device",
    keywords: ["base url", "server", "api key", "token", "tenant", "endpoint", "self hosted"],
  },
  {
    key: "appearance",
    label: "Display",
    category: "Device",
    // The section grew from theme-only to theme + list density + landing
    // screen (LOVE#51). People will search for the thing they want to change
    // — "compact", "start screen" — not for the heading it now lives under.
    keywords: [
      "theme",
      "dark mode",
      "light mode",
      "colour",
      "color",
      "system",
      "density",
      "compact",
      "comfortable",
      "spacing",
      "row height",
      "landing",
      "start screen",
      "home screen",
      "default tab",
      "tab order",
    ],
  },
  {
    key: "push",
    label: "Push notifications",
    category: "Device",
    keywords: ["alerts", "badge", "banner", "device", "permission", "notifications"],
  },
  {
    key: "push-topics",
    label: "What to notify me about",
    category: "Device",
    keywords: ["topics", "events", "mute", "quiet", "bounce", "approval"],
  },
  {
    key: "app-lock",
    label: "App lock",
    category: "Device",
    keywords: ["face id", "touch id", "biometric", "passcode", "lock", "unlock", "security"],
  },
  {
    key: "widget",
    label: "iOS widget privacy",
    category: "Device",
    keywords: ["widget", "home screen", "metrics", "lock screen"],
  },
  {
    key: "telemetry",
    label: "Privacy",
    category: "Privacy",
    keywords: ["analytics", "usage data", "telemetry", "opt out", "tracking"],
  },
  {
    key: "account-deletion",
    label: "Delete account",
    category: "Privacy",
    keywords: ["delete", "close account", "erase", "remove me"],
  },
  {
    key: "privacy-requests",
    label: "Data export and privacy requests",
    category: "Privacy",
    keywords: ["gdpr", "ccpa", "dsar", "subject access", "export my data", "portability"],
  },
  {
    key: "workspace-exports",
    label: "Workspace exports",
    category: "Privacy",
    keywords: ["export", "download", "backup", "archive", "zip", "take my data"],
  },
  {
    key: "retention",
    label: "Data retention",
    category: "Privacy",
    keywords: ["retention", "keep", "delete after", "audit log", "purge"],
  },
  {
    key: "legal",
    label: "Legal and support",
    category: "Privacy",
    keywords: ["terms", "privacy policy", "support", "help", "contact", "licence", "license"],
  },
  {
    key: "workspace",
    label: "Workspace",
    category: "Workspace",
    keywords: ["display name", "reply-to", "timezone", "brand", "logo", "branding"],
  },
  {
    key: "email-notifications",
    label: "Notifications",
    category: "Workspace",
    keywords: ["email me", "alerts", "bounce", "send complete", "approval request"],
  },
  {
    key: "digest",
    label: "Dashboard digest",
    category: "Workspace",
    keywords: ["digest", "summary", "daily", "weekly", "rollup"],
  },
  {
    key: "approval-governance",
    label: "Approval governance",
    category: "Workspace",
    keywords: ["approvals", "escalation", "policy", "cover", "on call"],
  },
  {
    key: "outbound-webhooks",
    label: "Outbound webhooks",
    category: "Workspace",
    keywords: ["webhook", "http", "endpoint", "events", "signing secret", "integration"],
  },
  {
    key: "webhook-alerts",
    label: "Webhook alerts",
    category: "Workspace",
    keywords: ["webhook", "failure", "alert", "failing destination"],
  },
  {
    key: "voice-labels",
    label: "Voice labels",
    category: "Workspace",
    keywords: ["voice", "tone", "brand voice", "ai", "training"],
  },
  {
    key: "slack-workspace",
    label: "Slack workspace",
    category: "Workspace",
    keywords: ["slack", "approval bot", "channel", "disconnect", "chat"],
  },
  {
    key: "sample-data",
    label: "Sample data",
    category: "Workspace",
    keywords: ["demo", "sample", "seed", "test data", "example", "onboarding"],
  },
];

function haystack(anchor: SettingsAnchor): string {
  return `${anchor.label} ${anchor.category} ${anchor.keywords.join(" ")}`.toLowerCase();
}

/**
 * Every whitespace-separated token in the query must appear somewhere in the
 * entry. Requiring ALL tokens is what makes "workspace export" narrow to one
 * row instead of returning everything that mentions either word.
 */
export function searchSettings(
  query: string,
  anchors: readonly SettingsAnchor[] = SETTINGS_ANCHORS,
): SettingsAnchor[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...anchors];
  return anchors.filter((anchor) => {
    const text = haystack(anchor);
    return tokens.every((token) => text.includes(token));
  });
}

export function filterSettingsByCategory(
  anchors: readonly SettingsAnchor[],
  category: SettingsCategory | null,
): SettingsAnchor[] {
  if (!category) return [...anchors];
  return anchors.filter((anchor) => anchor.category === category);
}
