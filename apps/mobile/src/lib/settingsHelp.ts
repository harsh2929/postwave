/**
 * settingsHelp — the contextual help mobile never had.
 *
 * Desktop ships a 464-line ContextualHelpPanel plus an `InlineHelp` tooltip
 * used six times in Settings alone. Mobile's only explanation is the one-line
 * `hint` under each control, and those hints carry load they cannot hold:
 * "Registers or unregisters this device for push notification delivery"
 * describes the MECHANISM and answers none of the questions someone actually
 * has — what will buzz me, does this affect my colleagues, can I undo it.
 *
 * The gap was never the affordance. Mobile already renders help inline, which
 * is the right pattern for a touch UI; a hover tooltip has nowhere to live on
 * a phone. The gap was that a single line has room for WHAT a control does and
 * no room for what it COSTS — and a permanently-visible paragraph under every
 * switch would drown the screen it is trying to explain.
 *
 * So this is the second layer, opened on demand, keyed by the same anchor the
 * Settings index already uses. Three fields, in the order a person asks them:
 *
 *   what        — one sentence, plain language, no jargon.
 *   consequence — what changes for OTHER people, or what cannot be undone.
 *                 Omitted where a control is genuinely local and reversible;
 *                 an invented consequence is worse than none.
 *   scope       — "this device" / "you, in this workspace" / "everyone in this
 *                 workspace". The single most common misunderstanding in a
 *                 settings screen that mixes all three.
 *
 * Import-free so the copy and its coverage guard are node-testable.
 */

export type SettingsHelpScope =
  | "This device only"
  | "You, in this workspace"
  | "Everyone in this workspace";

export interface SettingsHelp {
  what: string;
  consequence?: string;
  scope: SettingsHelpScope;
}

export const SETTINGS_HELP: Readonly<Record<string, SettingsHelp>> = {
  account: {
    what: "Who you are signed in as, and the role that decides which of these settings you can change.",
    scope: "You, in this workspace",
  },
  security: {
    what: "Two-factor enrolment and the list of devices holding a live session for your account.",
    consequence:
      "Signing a device out ends its session immediately; anything it had queued offline is sent from that device only when it signs back in.",
    scope: "You, in this workspace",
  },
  "viewer-preview": {
    what: "Renders the app as a lower role would see it, so you can check what a viewer or editor is shown before you invite one.",
    consequence:
      "It changes what you see, not what you may do — the server still enforces your real role on every request.",
    scope: "This device only",
  },
  "api-connection": {
    what: "Which Moosewave server this app talks to, and the credential it uses.",
    consequence:
      "Changing it signs this device out of the current workspace and clears the data cached for it.",
    scope: "This device only",
  },
  appearance: {
    what:
      "Theme (light, dark, or the phone's own setting), how much air list rows get, and which screen the app opens on.",
    consequence:
      "Compact removes padding only — text size still follows the phone's accessibility setting.",
    scope: "This device only",
  },
  push: {
    what: "Whether this phone is registered to receive Moosewave notifications at all.",
    consequence:
      "Turning it off unregisters this device. Your other devices keep receiving alerts, and iOS only asks for permission once per install.",
    scope: "This device only",
  },
  "push-topics": {
    what: "Which kinds of event may buzz this phone — approvals, send results, deliverability problems.",
    consequence:
      "Switching every topic off is the same as turning push off; the server reads an empty list as 'no preference' and falls back to its own defaults.",
    scope: "This device only",
  },
  "app-lock": {
    what: "Requires Face ID, Touch ID or the device passcode before the app will show workspace data.",
    consequence:
      "While it is on, the home-screen widget cannot show workspace metrics — a widget sits outside the app lock.",
    scope: "This device only",
  },
  widget: {
    what: "Lets the home-screen widget store subscriber totals, open rate and workspace name so it can render them.",
    consequence:
      "Those values live in the shared App Group for up to fifteen minutes and can appear on a locked screen.",
    scope: "This device only",
  },
  telemetry: {
    what: "Anonymous product analytics: which screens are used, how long things take, and structured error codes.",
    consequence:
      "No subscriber data, email content, names, or raw workspace identifiers are ever included.",
    scope: "This device only",
  },
  "account-deletion": {
    what: "Starts deletion of your own Moosewave user account.",
    consequence:
      "It cannot be undone and it does not delete the workspace — an owner must transfer ownership first or the workspace is left without one.",
    scope: "You, in this workspace",
  },
  "privacy-requests": {
    what: "The workspace's data-subject requests — exports, deletions, appeals — each with the statutory deadline its region sets.",
    consequence:
      "The deadline is legal, not advisory. A denial or a legal hold is recorded in the audit log against your name.",
    scope: "Everyone in this workspace",
  },
  "workspace-exports": {
    what: "Downloadable archives of this workspace's data, built on demand.",
    consequence:
      "The download link is signed and expires 24 hours after the bundle is built; anyone holding it before then can use it.",
    scope: "Everyone in this workspace",
  },
  retention: {
    what: "How long audit entries, email events and subscriber activity are kept before nightly purge.",
    consequence:
      "Shortening a window deletes everything already older than it, permanently, on the next nightly run.",
    scope: "Everyone in this workspace",
  },
  legal: {
    what: "Privacy policy, terms, support, and the contact for privacy questions.",
    scope: "You, in this workspace",
  },
  workspace: {
    what: "Display name, reply-to address, timezone and branding for the whole workspace.",
    consequence:
      "The timezone here decides when scheduled sends fire and which day a digest covers, for everyone.",
    scope: "Everyone in this workspace",
  },
  "email-notifications": {
    what: "Which workspace events email YOU. Separate from push, which is per device.",
    scope: "You, in this workspace",
  },
  digest: {
    what: "A periodic rollup of workspace activity, emailed to you daily or weekly.",
    scope: "You, in this workspace",
  },
  "approval-governance": {
    what: "The rules that decide what needs a second pair of eyes before it can send.",
    consequence:
      "Relaxing them applies to every campaign from that moment on, including ones already drafted.",
    scope: "Everyone in this workspace",
  },
  "outbound-webhooks": {
    what: "HTTP endpoints Moosewave posts to when workspace events happen.",
    consequence:
      "The signing secret is shown once when it is created or rotated. Rotating it breaks every receiver still verifying with the old one.",
    scope: "Everyone in this workspace",
  },
  "webhook-alerts": {
    what: "When to be told a webhook is failing — the failure rate and latency that count as a problem.",
    scope: "You, in this workspace",
  },
  "voice-labels": {
    what: "Tone samples that teach the AI writing tools how this workspace sounds.",
    consequence:
      "Labels are shared, so a sample you add shapes the suggestions everyone here gets.",
    scope: "Everyone in this workspace",
  },
  "slack-workspace": {
    what: "The Slack workspace the approval bot posts to, and the channel it defaults to.",
    consequence:
      "Disconnecting revokes the grant immediately — approval requests stop reaching Slack, and reconnecting has to be done from a signed-in browser because it is an OAuth install.",
    scope: "Everyone in this workspace",
  },
  "sample-data": {
    what: "A demo set of subscribers, lists, segments, campaigns and sequences, so an empty workspace has something to show.",
    consequence:
      "Seeded rows carry a sample marker and removing them deletes only those rows; your own data is never touched. Both actions apply to the whole workspace, not just your view of it.",
    scope: "Everyone in this workspace",
  },
};

/** The help for one anchor, or null when none is written for it. */
export function settingsHelpFor(key: string): SettingsHelp | null {
  return SETTINGS_HELP[key] ?? null;
}

/**
 * The spoken/rendered body, assembled in one place so the sheet and the
 * accessibility label can never drift apart.
 */
export function settingsHelpParagraphs(help: SettingsHelp): string[] {
  return [help.what, ...(help.consequence ? [help.consequence] : [])];
}
