/** Fail-closed packet boundary and loaded incident activity evidence. */

import type { ReactElement } from "react";

import {
  type PrivacyIncidentEvent,
  type PrivacyIncidentState,
} from "../../lib/api-client";
import { fmtDateTime, fmtRelative } from "../../lib/format-date";
import {
  isInitialRemoteLoad,
  type RemoteResource,
} from "../../lib/remote-resource";
import { RemoteDataNotice } from "../RemoteDataNotice";
import { SectionHeader } from "../SectionHeader";
import { PrivacyIncidentReleaseHold } from "./PrivacyIncidentReleaseHold";

const STATE_LABEL: Record<PrivacyIncidentState, string> = {
  open: "Open",
  contained: "Contained",
  notifications_pending: "Notifying",
  closed: "Closed",
};

function notificationAudienceLabel(audience: string | undefined): string {
  switch (audience) {
    case "authority":
      return "Authority";
    case "customer":
      return "Customer";
    case "data_subject":
      return "Data subject";
    default:
      return audience?.trim() || "Unknown audience";
  }
}

export function PrivacyIncidentPacketsSection(): ReactElement {
  return (
    <section className="privacy-incident-detail-section">
      <SectionHeader
        title="Packets"
        description="Audience packet slots are visible for planning only. No packet is generated, approved, downloaded, or sent from this release."
      />
      <PrivacyIncidentReleaseHold
        title="Packet generation and download are on release hold"
        description="Stored legacy template references can correspond to unverified operational assertions, and the desktop does not receive a durable content hash or approval receipt. Exposing a file would make a draft look legally ready."
        checkpoints={[
          "Counsel-approved, jurisdiction-aware content with an explicit template version.",
          "A durable packet digest, approval identity, generation time, and audit receipt.",
          "A download policy that is state-bound, authorized, and independently tested.",
        ]}
        testId="privacy-incident-packets-release-hold"
      >
        <div
          className="privacy-incident-packet-statuses"
          aria-label="Packet readiness"
        >
          {["Authority", "Customer", "Data subject"].map((audience) => (
            <div className="privacy-incident-packet-status" key={audience}>
              <strong>{audience}</strong>
              <span>Not generated · not approved · not sent</span>
            </div>
          ))}
        </div>
      </PrivacyIncidentReleaseHold>
    </section>
  );
}

export function PrivacyIncidentActivitySection({
  resource,
  onRetry,
}: {
  resource: RemoteResource<PrivacyIncidentEvent[]>;
  onRetry: () => void;
}): ReactElement {
  const events = resource.data;
  return (
    <section className="privacy-incident-detail-section">
      <SectionHeader
        title="Activity"
        description="Loaded transition and notification entries returned by the server. This view is not a complete or cryptographically verified evidence chain."
      />
      <RemoteDataNotice
        resource={resource}
        label="incident activity"
        onRetry={onRetry}
      />
      {isInitialRemoteLoad(resource) ? (
        <div className="muted" role="status" aria-busy="true">
          Loading incident activity…
        </div>
      ) : events === null ? null : events.length === 0 ? (
        <div className="muted">No activity entries are loaded.</div>
      ) : (
        <ol className="privacy-incident-activity-list">
          {events.map((event) => (
            <li
              key={`${event.source}:${event.event_id}`}
              className="privacy-incident-activity-item"
            >
              <span
                aria-hidden
                className={`privacy-incident-activity-marker is-${event.kind}`}
              />
              <div>
                <div className="privacy-incident-activity-copy">
                  {event.kind === "transition" ? (
                    <>
                      <strong>
                        {STATE_LABEL[
                          (event.from_state ?? "") as PrivacyIncidentState
                        ] ||
                          event.from_state ||
                          "Unknown"}
                      </strong>
                      {" → "}
                      <strong>
                        {STATE_LABEL[
                          (event.to_state ?? "") as PrivacyIncidentState
                        ] ||
                          event.to_state ||
                          "Unknown"}
                      </strong>
                      {event.reason ? (
                        <span className="muted"> · {event.reason}</span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      Notification entry recorded for{" "}
                      <strong>
                        {notificationAudienceLabel(event.audience)}
                      </strong>
                      {event.template_key ? (
                        <span className="muted">
                          {" "}
                          · Template <code>{event.template_key}</code>
                        </span>
                      ) : null}
                      {event.recipient_ref ? (
                        <span className="muted">
                          {" "}
                          · Recipient reference withheld in this view
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
                <div className="muted privacy-incident-activity-meta">
                  <span>{event.actor || "Actor not recorded"}</span>
                  <span aria-hidden="true"> · </span>
                  {event.at ? (
                    <time dateTime={event.at}>
                      {fmtDateTime(event.at)} ({fmtRelative(event.at)})
                      <code>{new Date(event.at).toISOString()}</code>
                    </time>
                  ) : (
                    "Time not recorded"
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
