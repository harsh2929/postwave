/**
 * WebhooksHome — unified /webhooks page with Inbound / Outbound tabs.
 * Refined Webhooks PR 4. Renders the existing InboundWebhooks +
 * OutboundWebhooks pages inside a tabbed shell so admins have one
 * surface for the whole subject.
 *
 * Renamed sidebar section: webhooks (formerly "Inbound webhooks" +
 * "Outbound webhooks" separately).
 */

import { type ReactElement, useState } from "react";

import { InlineHelp } from "../components/InlineHelp";
import { EventCatalogDialog } from "../components/webhooks/EventCatalogDialog";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { useDesktopRouteTab } from "../lib/desktop-router";
import { InboundWebhooks } from "./InboundWebhooks";
import { OutboundWebhooks } from "./OutboundWebhooks";
import "../styles-webhooks.css";

type Tab = "inbound" | "outbound";
const WEBHOOK_TABS = [{ value: "outbound" }, { value: "inbound" }] as const;

export function WebhooksHome(): ReactElement {
  const [tab, setTab] = useDesktopRouteTab<Tab>(
    "webhooks",
    ["outbound", "inbound"],
    "outbound",
  );
  const [catalogOpen, setCatalogOpen] = useState(false);
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: WEBHOOK_TABS,
    onChange: setTab,
  });
  const direction =
    tab === "outbound"
      ? {
          path: "Moosewave → your systems",
          detail: "Signed, retryable event delivery",
        }
      : {
          path: "External systems → Moosewave",
          detail: "Verified ingest, then trigger evaluation",
        };

  return (
    <div className={`wh-route-shell wh-route-shell--${tab}`}>
      <div className="wh-home-toolbar">
        <div className="wh-direction-switcher">
          <span className="wh-direction-label">Integration direction</span>
          <div
            ref={tabs.listRef}
            className="lib-segmented"
            {...tabs.listProps}
            aria-label="Webhook direction"
          >
            <button
              type="button"
              {...tabs.getTabProps("outbound")}
              className={tab === "outbound" ? "is-active" : ""}
            >
              Outbound
            </button>
            <button
              type="button"
              {...tabs.getTabProps("inbound")}
              className={tab === "inbound" ? "is-active" : ""}
            >
              Inbound
            </button>
          </div>
        </div>
        <div className="wh-direction-context" aria-live="polite">
          <span className="wh-direction-mark" aria-hidden="true">
            {tab === "outbound" ? "↗" : "↙"}
          </span>
          <span className="wh-direction-copy">
            <strong>{direction.path}</strong>
            <span>{direction.detail}</span>
          </span>
        </div>
        <InlineHelp
          text="Outbound = Moosewave sends selected, producer-backed events to your HTTPS receiver and retries according to delivery policy. Inbound = a sender implementing Moosewave's timestamped HMAC contract can persist events and run configured trigger actions."
          ariaLabel="What outbound vs inbound webhooks means"
        />
        <span className="spacer" />
        {tab === "outbound" ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setCatalogOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={catalogOpen ? "true" : "false"}
            >
              Outbound event catalog
            </button>
            <InlineHelp
              text="This is the complete producer-backed outbound catalog, with representative data inside the canonical signed envelope."
              ariaLabel="What's in the outbound event catalog"
            />
          </>
        ) : null}
      </div>

      <section className="wh-route-panel" {...tabs.getPanelProps(tab)}>
        {tab === "outbound" ? <OutboundWebhooks /> : <InboundWebhooks />}
      </section>

      <EventCatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
      />
    </div>
  );
}
