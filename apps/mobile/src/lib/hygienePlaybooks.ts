/**
 * hygienePlaybooks — the three canned remediation playbooks, ported from
 * desktop's HygienePlaybooks.tsx so both clients teach the same recipes.
 *
 * Import-free data so the copy is testable under node vitest, and so a future
 * fourth playbook is a data edit, not a component edit.
 */

export interface PlaybookStep {
  lead: string;
  detail: string;
}

export interface HygienePlaybook {
  id: string;
  title: string;
  summary: string;
  intro: string;
  steps: PlaybookStep[];
}

export const HYGIENE_PLAYBOOKS: readonly HygienePlaybook[] = [
  {
    id: "sunset",
    title: "Sunset flow",
    summary: "Re-engage or suppress subscribers who haven't opened in 90+ days.",
    intro:
      "Mailbox providers (Gmail / Yahoo) penalize senders that keep mailing dormant addresses. A sunset flow protects your reputation:",
    steps: [
      {
        lead: "Identify",
        detail:
          "subscribers with no engagement in ≥90 days (open + click + reply + form-submit).",
      },
      {
        lead: "Win-back",
        detail:
          'series: 2–3 emails over 14 days with a single, friction-free CTA ("Still want these?").',
      },
      {
        lead: "Suppress",
        detail:
          "non-responders automatically — move them to a separate list and stop sending broadcasts. They are still reachable via 1:1 (e.g. account / transactional).",
      },
      {
        lead: "Measure",
        detail:
          "the suppression cohort's bounce + complaint deltas over the following 30 days.",
      },
    ],
  },
  {
    id: "mpp",
    title: "Apple Mail Privacy Protection (MPP)",
    summary: "Open rates from Apple Mail are inflated — here's what to use instead.",
    intro:
      "MPP pre-fetches images server-side when the recipient opens Apple Mail with privacy protection enabled (~40% of opens in most B2C audiences). Treat opens from Apple as inflated.",
    steps: [
      {
        lead: "Use clicks",
        detail:
          "as the primary engagement signal for segmentation, sunset flows, and send-time optimization.",
      },
      {
        lead: "Filter",
        detail:
          'Apple-MPP opens from your engagement-based segments — Moosewave does this automatically when "Exclude pre-fetched opens" is enabled in Send-time.',
      },
      {
        lead: "Compare cohorts",
        detail:
          "Apple vs Gmail open rates should track within ~5pp of each other once MPP is corrected for.",
      },
    ],
  },
  {
    id: "bounces",
    title: "Bounce-class playbook",
    summary: "Hard / soft / block / mailbox_full each need a different response.",
    intro: "",
    steps: [
      {
        lead: "Hard",
        detail: "address is invalid. Suppress immediately and never retry.",
      },
      {
        lead: "Soft",
        detail:
          "temporary failure. Retry with backoff up to 72h; after 5 soft bounces in 30 days, suppress.",
      },
      {
        lead: "Block",
        detail:
          "receiver rejected for reputation / content reasons. Pause sending to that domain and check blocklists. Don't keep retrying — it makes things worse.",
      },
      {
        lead: "Mailbox full",
        detail: "retry once per day for 7 days, then suppress.",
      },
      {
        lead: "DNS",
        detail: "the recipient's domain has no valid MX records. Suppress.",
      },
      {
        lead: "Content",
        detail:
          "receiver flagged the message body. Review template, then re-send via a different identity.",
      },
    ],
  },
];
