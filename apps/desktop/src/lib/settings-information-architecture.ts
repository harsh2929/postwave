import { SETTINGS_ANCHORS, type SettingsAnchor } from "./desktop-router";

export const SETTINGS_CATEGORIES = [
  { id: "getting-started", label: "Getting started" },
  { id: "account", label: "Account" },
  { id: "workspace", label: "Workspace" },
  { id: "team-access", label: "Team & access" },
  { id: "plans-usage", label: "Plans & usage" },
  { id: "data-privacy", label: "Data & privacy" },
  { id: "developer-security", label: "Developer & security" },
  { id: "desktop-app", label: "Desktop app" },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]["id"];

export interface SettingsInformationItem {
  anchor: SettingsAnchor;
  category: SettingsCategoryId;
  label: string;
  summary: string;
  keywords: readonly string[];
}

type SettingsInformationMetadata = Omit<SettingsInformationItem, "anchor">;

const SETTINGS_METADATA = {
  "setup-progress": {
    category: "getting-started",
    label: "Setup progress",
    summary:
      "Finish the essential connection, sign-in, security, and theme steps.",
    keywords: ["checklist", "onboarding", "start"],
  },
  "api-connection": {
    category: "developer-security",
    label: "API connection",
    summary:
      "Connect this desktop app to a Moosewave gateway and workspace key.",
    keywords: ["url", "gateway", "bearer", "server", "self-hosted"],
  },
  "ai-brand-voice-gate": {
    category: "developer-security",
    label: "AI brand-voice gate",
    summary: "Test model and prompt changes against approved brand examples.",
    keywords: ["regression", "golden set", "model", "prompt", "quality"],
  },
  appearance: {
    category: "desktop-app",
    label: "Appearance",
    summary: "Follow the operating system theme or choose light or dark mode.",
    keywords: ["theme", "system", "light", "dark", "color"],
  },
  privacy: {
    category: "account",
    label: "Privacy",
    summary:
      "Control telemetry and request account deletion or a portable export.",
    keywords: ["telemetry", "analytics", "delete account", "gdpr", "download"],
  },
  about: {
    category: "desktop-app",
    label: "About",
    summary:
      "View the app version, legal resources, source, and support links.",
    keywords: ["version", "legal", "support", "terms", "source"],
  },
  security: {
    category: "account",
    label: "Security",
    summary: "Review the signed-in identity and manage two-step verification.",
    keywords: ["2fa", "totp", "authenticator", "login", "identity"],
  },
  "approve-another-device": {
    category: "account",
    label: "Approve another device",
    summary:
      "Review a matching sign-in code before approving or denying another device.",
    keywords: ["device", "sign in", "approval code", "login", "deny"],
  },
  tour: {
    category: "getting-started",
    label: "Tour",
    summary:
      "Walk the complete workspace, take a quick tour, or explore one area.",
    keywords: ["walkthrough", "help", "learn", "replay", "onboarding"],
  },
  workspace: {
    category: "account",
    label: "Workspace",
    summary: "Sign out and clear this device's local connection state.",
    keywords: ["sign out", "logout", "reset", "disconnect", "device"],
  },
  slack: {
    category: "workspace",
    label: "Slack",
    summary: "Connect or disconnect the workspace approval bot.",
    keywords: ["oauth", "integration", "approval bot", "channel"],
  },
  "sample-data": {
    category: "getting-started",
    label: "Sample data",
    summary: "Add or remove a safe demonstration dataset for evaluation.",
    keywords: ["demo", "seed", "example", "trial", "onboarding"],
  },
  "outbound-webhooks": {
    category: "developer-security",
    label: "Outbound webhooks",
    summary:
      "Review webhook health, then manage endpoints in the canonical Webhooks area.",
    keywords: [
      "callback",
      "endpoint",
      "subscription",
      "delivery",
      "integration",
    ],
  },
  "desktop-updates": {
    category: "desktop-app",
    label: "Desktop updates",
    summary:
      "Check, download, defer, install, and restart into signed releases.",
    keywords: ["upgrade", "release", "version", "restart", "installer"],
  },
  "desktop-window": {
    category: "desktop-app",
    label: "Desktop window",
    summary: "Choose whether closing the window asks, hides to tray, or quits.",
    keywords: ["close", "tray", "quit", "hide", "position"],
  },
  "keyboard-shortcuts": {
    category: "desktop-app",
    label: "Keyboard shortcuts",
    summary: "Review navigation and action shortcuts for the current platform.",
    keywords: ["hotkeys", "keys", "commands", "accessibility", "navigation"],
  },
  "custom-fields-governance": {
    category: "data-privacy",
    label: "Custom fields governance",
    summary:
      "Review and tune workspace limits for custom and searchable fields.",
    keywords: ["schema", "limits", "subscriber fields", "searchable", "caps"],
  },
  "form-firewall": {
    category: "developer-security",
    label: "Form firewall",
    summary:
      "Configure bot protection, attack mode, and signup risk thresholds.",
    keywords: ["spam", "bot", "abuse", "attack", "risk"],
  },
  "data-privacy": {
    category: "data-privacy",
    label: "Data privacy",
    summary: "Choose which subscriber fields are masked before AI processing.",
    keywords: ["pii", "mask", "tokenize", "ai", "subscriber"],
  },
  "inactive-api-keys": {
    category: "developer-security",
    label: "Inactive API keys",
    summary: "Find stale workspace keys and remove unnecessary access.",
    keywords: ["unused", "credentials", "token", "revoke", "security"],
  },
  "feature-flags": {
    category: "developer-security",
    label: "Feature flags",
    summary: "Inspect tenant overrides and platform-default feature states.",
    keywords: ["override", "rollout", "experiment", "toggle", "admin"],
  },
  "export-retention": {
    category: "data-privacy",
    label: "Export retention",
    summary:
      "Control how long generated workspace exports remain downloadable.",
    keywords: ["expiry", "download", "zip", "cleanup", "policy"],
  },
  "approval-chain": {
    category: "team-access",
    label: "Approval chain",
    summary:
      "Set the ordered roles that must approve a campaign before sending.",
    keywords: ["workflow", "review", "roles", "campaign", "governance"],
  },
  "archive-domain": {
    category: "workspace",
    label: "Archive domain",
    summary: "Publish the public archive on a verified custom domain with TLS.",
    keywords: ["cname", "dns", "ssl", "tls", "vanity", "custom domain"],
  },
  "data-exports": {
    category: "data-privacy",
    label: "Data exports",
    summary: "Create and download portable workspace data bundles.",
    keywords: ["backup", "jsonl", "zip", "download", "portability"],
  },
  "api-keys": {
    category: "developer-security",
    label: "API keys",
    summary: "Create, rotate, scope, and revoke workspace bearer tokens.",
    keywords: ["credentials", "token", "secret", "scope", "integration"],
  },
  "identifier-transforms": {
    category: "data-privacy",
    label: "Identifier transforms",
    summary:
      "Normalize email and phone identifiers as subscriber data enters Moosewave.",
    keywords: ["canonicalize", "email", "phone", "e164", "deduplicate"],
  },
  region: {
    category: "workspace",
    label: "Region",
    summary: "See where this deployment runs and which regions it supports.",
    keywords: ["location", "residency", "deployment", "hosting", "read only"],
  },
  usage: {
    category: "plans-usage",
    label: "Usage",
    summary:
      "Inspect sends, metered costs, and active keys for this workspace.",
    keywords: ["billing", "meter", "cost", "ledger", "consumption"],
  },
  "your-plan": {
    category: "plans-usage",
    label: "Your plan",
    summary:
      "Review the current tier, resource limits, and monthly projection.",
    keywords: ["pricing", "billing", "quota", "limits", "forecast"],
  },
  "workspace-profile": {
    category: "workspace",
    label: "Workspace profile",
    summary: "Manage the display name, reply-to identity, timezone, and brand.",
    keywords: ["name", "reply to", "timezone", "logo", "branding"],
  },
  notifications: {
    category: "account",
    label: "Notifications",
    summary: "Choose account email and privacy-safe desktop notifications.",
    keywords: ["alerts", "email", "desktop", "preferences", "events"],
  },
  "dashboard-email-digest": {
    category: "account",
    label: "Dashboard email digest",
    summary:
      "Choose whether a workspace summary arrives daily, weekly, or never.",
    keywords: ["report", "summary", "daily", "weekly", "email"],
  },
  "webhook-alerts": {
    category: "account",
    label: "Webhook alerts",
    summary:
      "Choose when webhook failures, latency, or auto-disable events email you.",
    keywords: ["notification", "failure rate", "latency", "delivery", "email"],
  },
  "data-retention": {
    category: "data-privacy",
    label: "Data retention",
    summary:
      "Set retention periods for audit logs, events, and unsubscribed records.",
    keywords: ["delete", "expiry", "audit", "email events", "policy"],
  },
  "audit-access": {
    category: "team-access",
    label: "Audit access",
    summary: "Assign audit permissions to workspace roles.",
    keywords: ["rbac", "permissions", "scopes", "roles", "compliance"],
  },
} satisfies Record<SettingsAnchor, SettingsInformationMetadata>;

export const SETTINGS_INFORMATION_ARCHITECTURE: readonly SettingsInformationItem[] =
  SETTINGS_ANCHORS.map((anchor) => ({ anchor, ...SETTINGS_METADATA[anchor] }));

export const DEFAULT_SETTINGS_ANCHOR: SettingsAnchor = "setup-progress";

const CATEGORY_LABELS = new Map<SettingsCategoryId, string>(
  SETTINGS_CATEGORIES.map((category) => [category.id, category.label]),
);

export function settingsCategoryLabel(category: SettingsCategoryId): string {
  return CATEGORY_LABELS.get(category) ?? category;
}

export function settingsItemForAnchor(
  anchor: SettingsAnchor,
): SettingsInformationItem {
  return { anchor, ...SETTINGS_METADATA[anchor] };
}

export function settingsItemsForCategory(
  category: SettingsCategoryId,
): readonly SettingsInformationItem[] {
  return SETTINGS_INFORMATION_ARCHITECTURE.filter(
    (item) => item.category === category,
  );
}

export function normalizeSettingsSearch(value: string): string {
  return value
    .slice(0, 128)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function searchSettings(
  query: string,
  limit = 8,
): readonly SettingsInformationItem[] {
  const normalized = normalizeSettingsSearch(query);
  if (!normalized || limit <= 0) return [];
  const tokens = normalized.split(" ");
  return SETTINGS_INFORMATION_ARCHITECTURE.map((item, order) => {
    const label = normalizeSettingsSearch(item.label);
    const anchor = normalizeSettingsSearch(item.anchor);
    const category = normalizeSettingsSearch(
      settingsCategoryLabel(item.category),
    );
    const supporting = normalizeSettingsSearch(
      `${item.summary} ${item.keywords.join(" ")}`,
    );
    const haystack = `${label} ${anchor} ${category} ${supporting}`;
    if (!tokens.every((token) => haystack.includes(token))) return null;
    let score = 0;
    if (label === normalized) score += 120;
    else if (label.startsWith(normalized)) score += 90;
    else if (label.includes(normalized)) score += 70;
    if (anchor === normalized) score += 80;
    if (category.includes(normalized)) score += 35;
    for (const token of tokens) {
      if (label.startsWith(token)) score += 20;
      else if (label.includes(token)) score += 12;
      if (supporting.includes(token)) score += 4;
    }
    return { item, order, score };
  })
    .filter(
      (
        match,
      ): match is {
        item: SettingsInformationItem;
        order: number;
        score: number;
      } => match !== null,
    )
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, Math.min(limit, SETTINGS_INFORMATION_ARCHITECTURE.length))
    .map((match) => match.item);
}
