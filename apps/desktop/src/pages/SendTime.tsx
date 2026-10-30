import type { ReactElement } from "react";

import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { SendTimeAudiencePanel } from "../components/sendtime/SendTimeAudiencePanel";
import {
  CampaignScheduleCard,
  useSendTimeCampaignScheduling,
} from "../components/sendtime/SendTimeScheduling";
import { SendTimeSubscriberInspector } from "../components/sendtime/SendTimeSubscriberInspector";
import { SendTimeWorkspacePolicy } from "../components/sendtime/SendTimeWorkspacePolicy";
import {
  useSendTimeAudienceSignals,
  useSendTimeWorkspaceSetting,
  useSubscriberSendTimeLookup,
} from "../components/sendtime/useSendTimeControllers";
import { CAMPAIGN_SCHEDULING_AVAILABLE } from "../lib/campaign-operational-availability";
import { useCanAdmin, useCanWrite, useMe } from "../lib/store";
import "../styles-send-time.css";

export { CampaignScheduleCard, useSendTimeCampaignScheduling };

export function SendTime(): ReactElement {
  const canAdmin = useCanAdmin();
  const canWrite = useCanWrite();
  const me = useMe();
  const identityKey = me?.tenant ?? "identity-unresolved";

  const workspaceSetting = useSendTimeWorkspaceSetting({
    canAdmin,
    identityKey,
  });
  const audience = useSendTimeAudienceSignals(identityKey);
  const subscriber = useSubscriberSendTimeLookup(identityKey);
  const scheduling = useSendTimeCampaignScheduling(
    workspaceSetting.enabled,
    canWrite,
    identityKey,
  );

  const audienceStatus =
    audience.catalog.kind === "loading"
      ? "Loading scopes"
      : audience.catalog.kind === "error"
        ? "Catalog unavailable"
        : audience.signal.kind === "ready"
          ? "Measured"
          : audience.signal.kind === "loading"
            ? "Analyzing"
            : audience.signal.kind === "insufficient"
              ? "Learning"
              : audience.signal.kind === "error"
                ? "Unavailable"
                : "Scope required";
  const defaultStatus =
    workspaceSetting.state.kind === "ready"
      ? workspaceSetting.state.enabled
        ? "New campaigns: on"
        : "New campaigns: off"
      : "Default unverified";

  return (
    <main className="stx-page">
      <PageHeader
        eyebrow="Optimization"
        title="Send-time intelligence"
        subtitle="Explore when a defined audience engages, inspect an individual recommendation, and keep delivery changes behind an explicit production-readiness gate."
        meta={
          <div className="stx-header-meta" aria-label="Send-time status">
            <span>
              <span className="stx-live-mark" aria-hidden="true" />
              Analysis · {audienceStatus}
            </span>
            <span>
              <Icon name="clock" size={13} />
              {defaultStatus}
            </span>
            <span>
              <Icon name="lock" size={13} />
              Delivery ·{" "}
              {CAMPAIGN_SCHEDULING_AVAILABLE ? "Available" : "Locked"}
            </span>
          </div>
        }
      />

      <section className="stx-hero" aria-labelledby="send-time-hero-title">
        <div className="stx-hero-copy">
          <div className="stx-kicker">Behavioral timing studio</div>
          <h2 id="send-time-hero-title">
            Find the hour your audience is already leaning in.
          </h2>
          <p>
            Moosewave turns measured positive engagement into a weekly attention
            map. Every recommendation stays tied to a named audience, a visible
            data window, and its real model coverage.
          </p>

          <ol className="stx-journey" aria-label="Send-time workflow">
            <li className="is-current">
              <span>01</span>
              <div>
                <strong>Scope</strong>
                <small>Choose one saved segment</small>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Read</strong>
                <small>Compare weekly signal</small>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Inspect</strong>
                <small>Validate one subscriber</small>
              </div>
            </li>
            <li className="is-locked">
              <span>04</span>
              <div>
                <strong>Activate</strong>
                <small>
                  {CAMPAIGN_SCHEDULING_AVAILABLE
                    ? "Review a durable plan"
                    : "Release gate in progress"}
                </small>
              </div>
            </li>
          </ol>
        </div>

        <SendTimeWorkspacePolicy
          canAdmin={canAdmin}
          controller={workspaceSetting}
        />
      </section>

      <SendTimeAudiencePanel controller={audience} />

      <div className="stx-tools-heading">
        <div>
          <div className="stx-kicker">Decision tools</div>
          <h2>Move from aggregate behavior to a safe action.</h2>
        </div>
        <p>
          Subscriber inspection is confidential. Campaign activation remains
          separate, privileged, and fail-closed.
        </p>
      </div>

      <div className="stx-tools-grid">
        <SendTimeSubscriberInspector controller={subscriber} />
        <CampaignScheduleCard
          controller={scheduling}
          stoEnabled={workspaceSetting.enabled}
          canWrite={canWrite}
        />
      </div>
    </main>
  );
}
