// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Receiver presets for the "New destination" gallery — pure data, so the
 * catalogue can be asserted from a node-environment test without mounting the
 * dialog. Mirrors apps/desktop/src/components/webhooks/receiver-presets.ts so
 * the two clients name the same receivers with the same guidance.
 *
 * `defaultEvents` are pre-ticked, not enforced: the create dialog still sends
 * whatever the operator leaves selected.
 */

export interface ReceiverPreset {
  name: string;
  urlPlaceholder: string;
  defaultEvents: string[];
  helpText: string;
  /** Pre-filled description so the new subscription is named usefully. */
  description: string;
}

export const RECEIVER_PRESETS: Record<string, ReceiverPreset> = {
  Zapier: {
    name: "Zapier",
    urlPlaceholder: "https://hooks.zapier.com/hooks/catch/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText:
      "Paste the Catch Hook URL from your Zap. We'll POST signed events to it whenever something happens in your workspace.",
    description: "Zapier — created via gallery",
  },
  "Make (Integromat)": {
    name: "Make (Integromat)",
    urlPlaceholder: "https://hook.make.com/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText: "Use the URL from your Custom Webhook module in Make.",
    description: "Make — created via gallery",
  },
  n8n: {
    name: "n8n",
    urlPlaceholder: "https://n8n.example.com/webhook/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText: "Use the production URL from your Webhook trigger node in n8n.",
    description: "n8n — created via gallery",
  },
  Discord: {
    name: "Discord",
    urlPlaceholder: "https://discord.com/api/webhooks/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText:
      "In your Discord server: Channel settings → Integrations → Webhooks → New Webhook, then copy the Webhook URL. Moosewave POSTs signed JSON; use a relay (Zapier/n8n) if you want Discord-native embeds.",
    description: "Discord — created via gallery",
  },
  "Microsoft Teams": {
    name: "Microsoft Teams",
    urlPlaceholder: "https://prod-….logic.azure.com/workflows/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText:
      'In Teams: channel → Workflows → "Post to a channel when a webhook request is received", then copy the request URL. (Legacy Office 365 connector URLs ending in webhook.office.com also work until Microsoft retires them.)',
    description: "Microsoft Teams — created via gallery",
  },
  "Your own server": {
    name: "Your own server",
    urlPlaceholder: "https://your-domain.com/webhooks/postwave",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText:
      "Any HTTPS endpoint works. Moosewave signs every request with the algorithm you pick below.",
    description: "Custom receiver",
  },
};

/** Gallery order — the record's insertion order, named explicitly. */
export const RECEIVER_PRESET_NAMES: string[] = Object.keys(RECEIVER_PRESETS);

export const DEFAULT_RECEIVER_PRESET = "Your own server";
