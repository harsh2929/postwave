/**
 * WebhookOnboardingGallery — replaces the empty state when a tenant
 * has zero webhooks configured. Shows 4 named receiver suggestions
 * with copy-paste connect strings. PR 1.
 *
 * Direction is inbound or outbound (different suggestions per direction).
 */

import { type ReactElement } from "react";

interface Props {
  direction: "inbound" | "outbound";
  /** Optional receiver name fires when a specific card is clicked.
   *  Parents can use this to pre-fill a ReceiverPresetDialog. */
  onCreate: (receiverName?: string) => void;
}

interface Receiver {
  name: string;
  hint: string;
  /** A short setup instruction — kept under 80 chars so the card stays compact. */
  setup: string;
}

const OUTBOUND_RECEIVERS: Receiver[] = [
  {
    name: "Zapier",
    hint: "Catch Hook",
    setup:
      "Create a Zap → Webhooks by Zapier → Catch Hook → copy the URL here.",
  },
  {
    name: "Make (Integromat)",
    hint: "Webhooks module",
    setup: "Add a Webhooks → Custom Webhook module and paste its URL.",
  },
  {
    name: "n8n",
    hint: "Webhook node",
    setup: "Add a Webhook trigger node, copy its production URL, paste here.",
  },
  {
    name: "Your own server",
    hint: "Anywhere on the internet",
    setup: "Any HTTPS endpoint works. We send signed POSTs; verify the HMAC.",
  },
];

const INBOUND_RECEIVERS: Receiver[] = [
  {
    name: "Your backend",
    hint: "Native HMAC sender",
    setup:
      "Sign the v2 length-framed timestamp, stable event ID, and exact JSON bytes.",
  },
  {
    name: "Automation relay",
    hint: "Zapier, Make, or n8n",
    setup: "Use a code step that can generate Moosewave's v2 framed HMAC.",
  },
  {
    name: "Provider adapter",
    hint: "Stripe, Shopify, or SaaS",
    setup: "Verify the provider signature, then re-sign and forward the JSON.",
  },
  {
    name: "Custom integration",
    hint: "Contract-compatible sender",
    setup: "Include event identity, timestamp, and a valid v2 HMAC signature.",
  },
];

export function WebhookOnboardingGallery({
  direction,
  onCreate,
}: Props): ReactElement {
  const receivers =
    direction === "outbound" ? OUTBOUND_RECEIVERS : INBOUND_RECEIVERS;
  const headline =
    direction === "outbound"
      ? "Send events to anywhere"
      : "Receive events from anywhere";
  const sub =
    direction === "outbound"
      ? "Add an HTTPS receiver and select the producer-backed events Moosewave should sign and deliver."
      : "Receive JSON from senders or adapters that implement Moosewave's versioned timestamp-and-event HMAC contract.";
  return (
    <div className="wh-onboarding">
      <div className="wh-onboarding-header">
        <div className="page-title" style={{ fontSize: 16 }}>
          {headline}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {sub}
        </div>
      </div>
      <div className="wh-onboarding-grid">
        {receivers.map((r) => (
          <button
            key={r.name}
            type="button"
            className="wh-onboarding-card"
            onClick={() => onCreate(r.name)}
          >
            <div className="wh-onboarding-card-head">
              <strong>{r.name}</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                {r.hint}
              </span>
            </div>
            <div
              className="wh-onboarding-card-body muted"
              style={{ fontSize: 12 }}
            >
              {r.setup}
            </div>
            <div className="wh-onboarding-card-go" aria-hidden>
              Set up →
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
