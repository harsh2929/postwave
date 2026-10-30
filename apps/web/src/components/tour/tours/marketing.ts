// SPDX-License-Identifier: AGPL-3.0-only
import type { Tour } from "../types";

export const marketingTour: Tour = {
  id: "marketing",
  startsOn: "/",
  steps: [
    {
      id: "hero",
      target: "marketing-hero",
      title: "Welcome to Moosewave.",
      body: "Let's take the scenic route — 90 seconds, tops. We'll show you what makes this different.",
      placement: "bottom",
      primaryLabel: "Show me",
    },
    {
      id: "pillars",
      target: "marketing-pillar-migrate",
      title: "Move with proof.",
      body: "Mailchimp, Substack, Beehiiv, ConvertKit, ActiveCampaign, and CSV paths bring source-supported subscribers and tags. Paid Stripe subscriptions move only on supported source-bound paths; Substack and Beehiiv premium metadata is evidence, not billing migration. Automations translate only where safe; otherwise Moosewave preserves rebuild evidence.",
      placement: "auto",
    },
    {
      id: "deliverability",
      target: "marketing-pillar-inbox",
      title: "Stop wondering. Know.",
      body: "Inbox Reality predicts placement and, when controlled testing is enabled, reports what the active seed roster observed. SPF, DKIM, DMARC, the works.",
      placement: "auto",
    },
    {
      id: "voice",
      target: "marketing-pillar-voice",
      title: "Sound like yourself.",
      body: "We train on your existing writing, then draft sequences in your actual voice. Fidelity-scored, regenerable, never robotic.",
      placement: "auto",
    },
    {
      id: "pricing",
      target: "marketing-pricing",
      title: "Review the provisional catalog.",
      body: "Sandbox simulates the workflow. Proposed paid entries remain under commercial review, and checkout stays closed until release approval.",
      placement: "top",
    },
    {
      id: "cta",
      target: "marketing-cta",
      title: "Continue the qualification review.",
      body: "Inspect migration evidence, release status, and the exact supported catalog before requesting access.",
      placement: "top",
      primaryLabel: "Let's go",
      celebrate: true,
    },
  ],
};
