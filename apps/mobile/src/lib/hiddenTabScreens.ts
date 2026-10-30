/**
 * lib/hiddenTabScreens.ts — every route that must be REGISTERED with the tab
 * navigator but never shown in the tab bar.
 *
 * ── WHY THE LIST HAS TO EXIST AT ALL ───────────────────────────────────────
 * Expo Router auto-registers any file under `app/(tabs)/` it finds. A route
 * that is not declared explicitly gets a default ▽ tab icon and leaks into the
 * tab bar, so every secondary screen must be named somewhere. These are reached
 * through the More menu and deep links, not the bar.
 *
 * ── WHY IT LIVES HERE AND NOT IN `_layout.tsx` ─────────────────────────────
 * As JSX this was ~110 lines of `<Tabs.Screen name=… options={hidden(…)} />`
 * with no logic in any of them, and it pushed `_layout.tsx` past its 450-line
 * ceiling the moment one more screen shipped. It is pure data, so it is stored
 * as data — which also makes it something a guard can compare against the route
 * manifest, rather than a wall a reader has to diff by eye.
 *
 * ── FOLDER INDEXES: THE TRAP THIS LIST ENCODES ─────────────────────────────
 * `sequences/`, `forms/`, `helpdesk/` and `sms/` have NO `<family>.tsx` and no
 * `_layout.tsx` — only `index.tsx` and a detail route. Expo Router therefore
 * registers the index as `sequences/index`, NOT `sequences`. Hiding the bare
 * folder name silently did nothing and the index leaked into the tab bar with a
 * truncated label ("sequenc…"). The registered name is the real one; that is
 * why four entries below carry an `/index` suffix.
 *
 * Their `[id]` / `[phone]` detail screens are NOT here: those take `SHELL`
 * options rather than `hidden(...)`, so they stay declared inline in the layout
 * where the difference is visible.
 *
 * Directory navigators (campaigns, subscribers, approvals, lists, segments,
 * suppressions) register their own children from their own `_layout.tsx`.
 * Naming those children here is what produces Expo Router's
 * "[Layout children]: No route named …" warning.
 */

/** `[registeredRouteName, accessible title]`. */
export type HiddenTabScreen = readonly [name: string, title: string];

export const HIDDEN_TAB_SCREENS: readonly HiddenTabScreen[] = [
  // Secondary routes.
  ["scan", "Scan QR code"],
  ["voice", "Voice"],
  ["integrations", "Integrations"],
  ["settings", "Settings"],
  ["audit", "Audit log"],

  // Expansion routes — added during desktop sprawl; they mirror the desktop's
  // sections and are reached via More → Audience / Sending / Compliance.
  ["tags", "Tags"],
  ["lists", "Lists"],
  ["analytics", "Analytics"],
  ["search", "Search"],
  ["notifications", "Notifications"],
  ["billing", "Plan & usage"],
  ["cli-approve", "Approve device"],
  ["suppressions", "Suppressions"],
  ["inbound-webhooks", "Inbound webhooks"],
  ["sending-settings", "Sending settings"],
  ["custom-domains", "Custom domains"],
  ["dmarc", "DMARC"],
  ["frequency-caps", "Frequency caps"],
  ["referrals", "Referrals"],
  ["subject-lab", "Subject Lab"],
  ["ai-chat", "Moosewave AI"],
  ["send-time", "Send time"],
  ["omnichannel", "Omnichannel"],
  ["helpdesk/index", "Helpdesk"],
  ["archive", "Archive"],
  ["discounts", "Discounts"],
  ["migrations", "Migrations"],
  ["audit-sinks", "Audit sinks"],
  ["audit-alerts", "Audit alerts"],
  ["templates", "Templates"],
  ["agent-routines", "Agent routines"],
  ["scim", "SCIM"],
  ["agency", "Agency"],
  ["assets", "Assets"],
  ["audience-syncs", "Audience syncs"],
  ["conversions", "Conversions"],
  ["subscriber-duplicates", "Duplicates"],
  ["lookalike", "Lookalike audiences"],
  ["gift-subscriptions", "Gift history"],
  ["collections", "Collections"],
  ["flow-ab-tests", "Flow A/B tests"],
  ["archive-comments", "Comment moderation"],
  ["compliance", "Compliance"],
  ["inbound-routes", "Inbound routing"],
  ["agent-activity", "Agent activity"],
  ["product-events", "Product events"],
  ["warehouse-runs", "Warehouse syncs"],
  ["retention-offers", "Retention offers"],
  ["privacy-incidents", "Breach incidents"],
  ["pii-findings", "Shadow-PII findings"],
  ["commerce", "Commerce"],
  ["flows", "Flows"],
  ["landing-pages", "Landing pages"],
  ["subscriber-imports", "Subscriber imports"],

  // Parity-round routes + governance. Discovery surfaces reached from More →
  // Tools / Account / Enterprise and from desktop deep links.
  ["sequences/index", "Sequences"],
  ["forms/index", "Forms"],
  ["segments", "Segments"],
  ["reviews", "Reviews"],
  ["diagnostics", "Diagnostics"],
  ["api-keys", "API keys"],
  ["agent-mandates", "Agent mandates"],
  ["sms/index", "SMS inbox"],
  ["sms/suppressions", "SMS opt-outs"],
  ["sms/broadcasts", "SMS broadcasts"],
  ["deliverability", "Deliverability"],
  ["webhooks", "Webhook health"],
  ["custom-objects", "Custom objects"],
];
