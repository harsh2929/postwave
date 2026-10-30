/**
 * EventCatalogDialog — discoverability for outbound webhook event
 * types. PR 2. Hardcoded sample payloads + descriptions per event
 * type so receivers know exactly what to expect.
 *
 * Source of truth for the event list is api-client.OUTBOUND_WEBHOOK_
 * EVENTS; this file enriches each with a sample payload + plain-
 * English description.
 */

import { type ReactElement, useState } from "react";

import { Modal, ModalFooter } from "../Modal";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { toast } from "../Toast";
import { writeClipboardText } from "../../lib/clipboard";
import {
  OUTBOUND_WEBHOOK_EVENTS,
  type OutboundWebhookEvent,
} from "../../lib/api-client";

interface CatalogEntry {
  event: OutboundWebhookEvent;
  description: string;
  /** The `event.data` payload for this event type (wrapped in the real
   *  delivery envelope for display — see buildEnvelope below). */
  data: Record<string, unknown>;
}

// D12-comms-webhooks#6 — these are the `event.data` bodies only. The prior
// version showed a hand-invented `{event, data}` top-level shape that matches
// NEITHER wire format; the real outbound delivery envelope (see
// apps/api/internal/outbound_webhooks/{dispatcher,playground}.go) wraps the
// payload as `{event:{id,type,occurred_at,data}, webhook:{id}, delivery:{id,
// attempt}}`. buildEnvelope() below reconstructs that exact shape so the
// copy-pasteable sample matches what a receiver actually parses.
const CATALOG_DETAILS: Record<
  OutboundWebhookEvent,
  Omit<CatalogEntry, "event">
> = {
  "campaign.sent": {
    description: "A campaign completed its send operation.",
    data: { campaign_id: "cmp_a1b2", recipients: 12_481 },
  },
  "subscriber.added": {
    description: "A tenant-wide subscriber record was added.",
    data: { subscriber_id: "sub_x9k2", email: "amy@example.com" },
  },
  "subscriber.removed": {
    description: "A tenant-wide subscriber record was removed.",
    data: { subscriber_id: "sub_x9k2", email: "amy@example.com" },
  },
  "subscriber.unsubscribed": {
    description: "A subscriber opted out across the tenant.",
    data: {
      subscriber_id: "sub_x9k2",
      email: "amy@example.com",
      reason: "one_click",
    },
  },
  "approval.requested": {
    description: "A campaign entered approval review.",
    data: { campaign_id: "cmp_a1b2", requested_by: "user_42" },
  },
  "approval.decided": {
    description: "A campaign approval was accepted or rejected.",
    data: {
      campaign_id: "cmp_a1b2",
      decided_by: "user_55",
      decision: "approved",
    },
  },
  "audit.created": {
    description: "An auditable workspace action was recorded.",
    data: { audit_id: "aud_7341", action: "campaign.send" },
  },
  "bounce.received": {
    description: "A recipient delivery bounce was received.",
    data: {
      email: "bounced@example.com",
      campaign_id: "cmp_a1b2",
      kind: "hard",
    },
  },
  "list_health.degraded": {
    description:
      "Workspace deliverability health crossed below the degraded threshold.",
    data: {
      account_score: 54,
      grade: "D",
      model_version: "v2",
      sample_qualified: true,
      sample_size: 12_481,
      window_days: 30,
      breaches: [
        {
          metric: "bounce_rate",
          observed: 0.061,
          threshold: 0.05,
          severity: "critical",
        },
      ],
      opens_machine_pct: 0.18,
      incident_snapshot_id: 7341,
    },
  },
  "list.subscriber.added": {
    description: "A subscriber was added to a specific list.",
    data: {
      list_id: "list_42",
      subscriber_id: "sub_x9k2",
      email: "amy@example.com",
    },
  },
  // Keyed on email_id, not on a subscriber: a transactional recipient need not
  // be a subscriber at all, and the question these answer is "what happened to
  // THIS message".
  "email.bounced": {
    description:
      "A transactional message was permanently rejected for one recipient.",
    data: {
      email_id: "eml_9f3a",
      recipient: "gone@example.com",
      outcome: "bounced",
      reason: "5.1.1 The email account that you tried to reach does not exist",
      esp: "ses",
    },
  },
  "email.complained": {
    description:
      "A recipient reported a transactional message as spam.",
    data: {
      email_id: "eml_9f3a",
      recipient: "annoyed@example.com",
      outcome: "complained",
      reason: "spam",
      esp: "ses",
    },
  },
  "email.delivered": {
    description:
      "A transactional message reached one recipient's mailbox.",
    data: {
      email_id: "eml_9f3a",
      recipient: "amy@example.com",
      outcome: "delivered",
      reason: "",
      esp: "ses",
    },
  },
  "assurance.run.completed": {
    description:
      "A Campaign Assurance run reached a terminal state. `decision` carries the verdict — `incomplete` means required evidence was unavailable and is NOT a pass.",
    data: {
      run_id: "run_7c21",
      campaign_id: "cmp_4f10",
      content_revision_id: "rev_9a02",
      profile: "full",
      state: "complete",
      decision: "allow",
      blocking_finding_count: 0,
    },
  },
  "assurance.run.blocked": {
    description:
      "A Campaign Assurance run found deterministic blockers. The campaign cannot be queued until each one is fixed or waived by an admin.",
    data: {
      run_id: "run_7c21",
      campaign_id: "cmp_4f10",
      content_revision_id: "rev_9a02",
      profile: "full",
      state: "complete",
      decision: "block",
      blocking_finding_count: 2,
    },
  },
};

export const OUTBOUND_EVENT_CATALOG: ReadonlyArray<CatalogEntry> =
  OUTBOUND_WEBHOOK_EVENTS.map((event) => ({
    event,
    ...CATALOG_DETAILS[event],
  }));

/**
 * Wrap an event's `data` in the real outbound delivery envelope so the
 * sample matches the wire byte-for-byte (webhook + delivery ids are filled
 * by the worker right before signing; the placeholders below mirror the
 * playground's shape).
 */
function buildEnvelope(entry: CatalogEntry): Record<string, unknown> {
  return {
    event: {
      id: "4fd5c4c8-156f-4f0d-9346-02ab38e928d8",
      type: entry.event,
      occurred_at: "2026-05-26T09:14:00Z",
      data: entry.data,
    },
    webhook: { id: "2a1030cc-dce6-4228-9ed1-b50282b32ee9" },
    delivery: {
      id: "f18786aa-1445-46d0-a36d-a70a0640b81b",
      attempt: 1,
    },
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function EventCatalogDialog({ open, onClose }: Props): ReactElement {
  const [selected, setSelected] = useState<string>(
    OUTBOUND_EVENT_CATALOG[0].event,
  );
  const tabs = useTabsInteraction({
    value: selected,
    items: OUTBOUND_EVENT_CATALOG.map((entry) => ({ value: entry.event })),
    onChange: setSelected,
    orientation: "vertical",
  });
  const entry =
    OUTBOUND_EVENT_CATALOG.find((c) => c.event === selected) ??
    OUTBOUND_EVENT_CATALOG[0];
  const pretty = JSON.stringify(buildEnvelope(entry), null, 2);

  const copy = async (): Promise<void> => {
    const result = await writeClipboardText(pretty, {
      contentClass: "public",
      label: "Webhook event sample",
    });
    if (result.ok) toast.success(`Copied ${entry.event} sample`);
    else toast.error(result.message);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Outbound event catalog"
      description="The complete canonical event catalog. These samples show the exact default event / webhook / delivery envelope; event.data is representative and an API-configured transform can change the final signed body."
    >
      <div className="wh-wire-contract" role="note">
        <div className="wh-wire-contract-heading">
          <strong>Canonical delivery headers</strong>
          <span>
            The <code>t=</code> timestamp lives inside the signature header.
          </span>
        </div>
        <div className="wh-wire-header-list" aria-label="Live delivery headers">
          <code>X-Postwave-Signature</code>
          <code>X-Postwave-Event</code>
          <code>X-Postwave-Event-Id</code>
          <code>X-Postwave-Delivery</code>
          <code>X-Postwave-Key-Id</code>
        </div>
        <p>
          Verify <code>X-Postwave-Signature</code> against the exact raw body
          before parsing it. The signature does not authenticate auxiliary{" "}
          <code>X-Postwave-Event-Id</code> or <code>X-Postwave-Delivery</code>{" "}
          headers. Deduplicate only an identity that remains inside the verified
          signed body; a transform can remove <code>event.id</code>.{" "}
          <code>X-Postwave-Key-Id</code> is present when signing key
          fingerprints are available.
        </p>
        <p>
          Operator tests and Simulator fires additionally send{" "}
          <code>X-Postwave-Test: true</code>; production event deliveries omit
          that test-only header.
        </p>
      </div>
      <div className="wh-catalog-grid">
        <div
          ref={tabs.listRef}
          className="wh-catalog-list"
          {...tabs.listProps}
          aria-label="Webhook event types"
        >
          {OUTBOUND_EVENT_CATALOG.map((c) => (
            <button
              key={c.event}
              type="button"
              {...tabs.getTabProps(c.event)}
              className={`wh-catalog-row${selected === c.event ? " is-active" : ""}`}
            >
              <strong>{c.event}</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                {c.description}
              </span>
            </button>
          ))}
        </div>
        {OUTBOUND_EVENT_CATALOG.map((catalogEntry) => (
          <div
            key={catalogEntry.event}
            {...tabs.getPanelProps(catalogEntry.event)}
            className="wh-catalog-detail"
          >
            <div
              className="muted"
              style={{
                fontSize: 11,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Representative signed body
            </div>
            {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Scrollable code must be keyboard-focusable so keyboard users can reach overflow content. */}
            <pre
              className="wh-verification-snippet"
              style={{ maxHeight: 280 }}
              role="region"
              aria-label={`${catalogEntry.event} representative signed body`}
              tabIndex={0}
            >
              <code>
                {JSON.stringify(buildEnvelope(catalogEntry), null, 2)}
              </code>
            </pre>
            {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
          </div>
        ))}
      </div>
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void copy()}
        >
          Copy sample
        </button>
      </ModalFooter>
    </Modal>
  );
}
