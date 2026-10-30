// SPDX-License-Identifier: AGPL-3.0-only
//
// Human labels for every MCP tool category in mcp-tools.json. The /mcp catalog
// renders one section heading per category; a missing label falls back to the
// raw kebab-case slug (e.g. "DEVELOPER-MARKETPLACE"), which reads as broken.
//
// This map is the single source of truth and is guarded by a test
// (mcp-category-labels.test.ts) that fails if any category in mcp-tools.json
// lacks a label OR if any label key does not correspond to a real category —
// so new tool categories fail closed instead of shipping as raw slugs.
//
// Declaration order is also the display order on /mcp (the page sorts
// categories by their position in this map).
export const MCP_CATEGORY_LABELS: Record<string, string> = {
  audience: "Audience",
  subscribers: "Subscribers",
  topics: "Topics",
  campaigns: "Campaigns",
  templates: "Templates",
  "template-render": "Template rendering",
  emails: "Transactional email",
  automations: "Automations",
  forms: "Forms",
  analytics: "Analytics",
  "send-time": "Send-time optimization",
  deliverability: "Deliverability",
  "link-check": "Link checks",
  "sending-settings": "Sending settings",
  "custom-domains": "Custom domains",
  voice: "Voice",
  "voice-drift": "Voice drift",
  sms: "SMS",
  push: "Push suppression authority",
  archive: "Archive",
  referrals: "Referrals",
  discounts: "Discounts",
  "gift-subscriptions": "Gift subscriptions",
  events: "Events",
  integrations: "Integrations",
  platform: "Platform (CDN, webhooks, inbound)",
  "developer-marketplace": "Developer marketplace",
  "agent-primitives": "Agent primitives",
  account: "Account",
  admin: "Admin",
  migration: "Migration",
};
