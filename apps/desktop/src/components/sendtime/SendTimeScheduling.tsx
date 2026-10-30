import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type Campaign,
  type ScheduleByBestTimeResponse,
  type SchedulePreviewResponse,
  type SendTimeStrategy,
  apiSendTimeAssets as api,
} from "../../lib/api-client";
import {
  CAMPAIGN_SCHEDULING_AVAILABLE,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
} from "../../lib/campaign-operational-availability";
import { setSection } from "../../lib/store";
import { Icon } from "../Icon";
import { toast } from "../Toast";
import { decodeSchedulePreview } from "./contract";
import {
  describeApiError,
  formatAbsoluteDate,
  parseOptionalLocalDateTime,
} from "./model";

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: SchedulePreviewResponse };

function campaignRows(payload: Awaited<ReturnType<typeof api.listCampaigns>>) {
  const data = payload.data;
  if (!data) return [];
  return Array.isArray(data)
    ? data
    : (data.items ?? data.results ?? data.data ?? []);
}

export function useSendTimeCampaignScheduling(
  _newCampaignDefaultEnabled: boolean,
  canWrite = true,
  identityKey = "",
) {
  const generation = useRef(0);
  const mounted = useRef(true);
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState("");
  const [strategy, setStrategy] = useState<SendTimeStrategy>("per_recipient");
  const [referenceAt, setReferenceAt] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [lastResult, setLastResult] =
    useState<ScheduleByBestTimeResponse | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const loadCampaigns = useCallback(async (): Promise<void> => {
    if (!CAMPAIGN_SCHEDULING_AVAILABLE) {
      setCampaigns([]);
      setCampaignsError(null);
      return;
    }
    const request = ++generation.current;
    setCampaigns(null);
    setCampaignsError(null);
    const response = await api.listCampaigns({ perPage: 100 });
    if (!mounted.current || request !== generation.current) return;
    if (response.error) {
      setCampaigns([]);
      setCampaignsError(describeApiError(response.error));
      return;
    }
    setCampaigns(campaignRows(response));
  }, []);

  useEffect(() => {
    generation.current += 1;
    setCampaignId("");
    setPreview({ kind: "idle" });
    setLastResult(null);
    setScheduleError(null);
    setReviewing(false);
    void loadCampaigns();
  }, [identityKey, loadCampaigns]);

  useEffect(() => {
    setReviewing(false);
    setScheduleError(null);
    if (!CAMPAIGN_SCHEDULING_AVAILABLE || !campaignId) {
      setPreview({ kind: "idle" });
      return;
    }
    const parsedReference = parseOptionalLocalDateTime(referenceAt);
    if (!parsedReference.ok) {
      setPreview({ kind: "error", message: parsedReference.message });
      return;
    }
    const request = ++generation.current;
    const timer = window.setTimeout(() => {
      setPreview({ kind: "loading" });
      const input = {
        strategy,
        ...(parsedReference.iso ? { reference_at: parsedReference.iso } : {}),
      };
      void api.previewScheduleByBestTime(campaignId, input).then((response) => {
        if (!mounted.current || request !== generation.current) return;
        if (response.error) {
          setPreview({
            kind: "error",
            message: describeApiError(response.error),
          });
          return;
        }
        const decoded = decodeSchedulePreview(response.data);
        if (!decoded) {
          setPreview({
            kind: "error",
            message:
              "The delivery preview response did not match its aggregate scheduling contract.",
          });
          return;
        }
        setPreview({ kind: "ready", data: decoded });
      });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      generation.current += 1;
    };
  }, [campaignId, referenceAt, strategy]);

  const eligibleCampaigns = useMemo(
    () =>
      (campaigns ?? []).filter((campaign) => {
        const status = (campaign.status ?? "draft").toLowerCase();
        return status === "draft" || status === "scheduled";
      }),
    [campaigns],
  );

  const requestReview = useCallback((): void => {
    if (!CAMPAIGN_SCHEDULING_AVAILABLE) {
      setScheduleError(CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON);
      return;
    }
    if (!canWrite) {
      setScheduleError("Your current role cannot change campaign schedules.");
      return;
    }
    if (!campaignId) {
      setScheduleError("Choose an eligible campaign first.");
      return;
    }
    if (preview.kind !== "ready") {
      setScheduleError("Wait for a successful dry-run preview before review.");
      return;
    }
    setScheduleError(null);
    setReviewing(true);
  }, [campaignId, canWrite, preview]);

  const submitSchedule = useCallback(async (): Promise<void> => {
    if (!CAMPAIGN_SCHEDULING_AVAILABLE) {
      setScheduleError(CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON);
      toast.error(CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON);
      return;
    }
    if (!canWrite || !reviewing || preview.kind !== "ready") {
      setScheduleError(
        "A successful preview and privileged confirmation are required.",
      );
      return;
    }
    const parsedReference = parseOptionalLocalDateTime(referenceAt);
    if (!parsedReference.ok) {
      setScheduleError(parsedReference.message);
      return;
    }
    const request = ++generation.current;
    setSubmitting(true);
    setScheduleError(null);
    const response = await api.scheduleCampaignByBestTime(campaignId, {
      strategy,
      ...(parsedReference.iso ? { reference_at: parsedReference.iso } : {}),
    });
    if (!mounted.current || request !== generation.current) return;
    setSubmitting(false);
    if (response.error) {
      setScheduleError(describeApiError(response.error));
      toast.error(`Schedule failed: ${describeApiError(response.error)}`);
      return;
    }
    if (response.data.persisted !== true) {
      setScheduleError(
        "The server did not confirm durable persistence. No successful activation is being claimed.",
      );
      return;
    }
    setLastResult(response.data);
    setReviewing(false);
    toast.success(
      `Durably scheduled ${response.data.scheduled.toLocaleString()} recipient${response.data.scheduled === 1 ? "" : "s"}.`,
    );
  }, [campaignId, canWrite, preview, referenceAt, reviewing, strategy]);

  return {
    campaigns,
    campaignsError,
    campaignId,
    setCampaignId,
    strategy,
    setStrategy,
    referenceAt,
    setReferenceAt,
    preview,
    submitting,
    scheduleError,
    // Compatibility alias for existing containment callers while the
    // fail-closed scheduling surface migrates to the explicit state name.
    scheduleErr: scheduleError,
    reviewing,
    setReviewing,
    lastResult,
    eligibleCampaigns,
    loadCampaigns,
    requestReview,
    submitSchedule,
  };
}

type Controller = ReturnType<typeof useSendTimeCampaignScheduling>;

export function CampaignScheduleCard({
  controller,
  stoEnabled: _newCampaignDefaultEnabled,
  canWrite = true,
}: {
  controller: Controller;
  stoEnabled: boolean;
  canWrite?: boolean;
}): ReactElement {
  if (!CAMPAIGN_SCHEDULING_AVAILABLE) {
    return <SchedulingReadiness />;
  }

  const {
    campaigns,
    campaignsError,
    campaignId,
    setCampaignId,
    strategy,
    setStrategy,
    referenceAt,
    setReferenceAt,
    preview,
    submitting,
    scheduleError,
    reviewing,
    setReviewing,
    lastResult,
    eligibleCampaigns,
    loadCampaigns,
    requestReview,
    submitSchedule,
  } = controller;

  return (
    <section
      className="stx-tool-card"
      aria-labelledby="send-time-schedule-title"
    >
      <div className="stx-tool-heading">
        <span className="stx-tool-icon" aria-hidden="true">
          <Icon name="megaphone" size={17} />
        </span>
        <div>
          <div className="stx-kicker">Simulate</div>
          <h2 id="send-time-schedule-title">Campaign delivery plan</h2>
          <p>
            Preview impact, review safeguards, then confirm a durable change.
          </p>
        </div>
      </div>

      {campaignsError ? (
        <div className="stx-inline-warning" role="alert">
          Campaigns could not be loaded: {campaignsError}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void loadCampaigns()}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="stx-schedule-fields">
        <div className="field">
          <label className="field-label" htmlFor="send-time-campaign">
            Eligible campaign
          </label>
          <select
            id="send-time-campaign"
            className="input"
            value={campaignId}
            disabled={campaigns === null || !!campaignsError}
            onChange={(event) => setCampaignId(event.target.value)}
          >
            <option value="">
              {campaigns === null
                ? "Loading campaigns…"
                : eligibleCampaigns.length === 0
                  ? "No draft or scheduled campaigns"
                  : "Choose a campaign…"}
            </option>
            {eligibleCampaigns.map((campaign) => (
              <option key={String(campaign.id)} value={String(campaign.id)}>
                {campaign.name ?? campaign.subject ?? `Campaign ${campaign.id}`}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="stx-strategy-field">
          <legend className="field-label">Optimization strategy</legend>
          <label
            className={strategy === "per_recipient" ? "is-selected" : ""}
            htmlFor="send-time-strategy-personal"
            aria-label="Per-recipient optimization strategy"
          >
            <input
              id="send-time-strategy-personal"
              type="radio"
              name="send_time_strategy"
              checked={strategy === "per_recipient"}
              onChange={() => setStrategy("per_recipient")}
            />
            <span>
              <strong>Per recipient</strong>
              <small>Personal window with a cold-start fallback.</small>
            </span>
          </label>
          <label
            className={strategy === "modal_hour" ? "is-selected" : ""}
            htmlFor="send-time-strategy-audience"
            aria-label="One-audience-window optimization strategy"
          >
            <input
              id="send-time-strategy-audience"
              type="radio"
              name="send_time_strategy"
              checked={strategy === "modal_hour"}
              onChange={() => setStrategy("modal_hour")}
            />
            <span>
              <strong>One audience window</strong>
              <small>Use the most common window for every recipient.</small>
            </span>
          </label>
        </fieldset>
        <div className="field">
          <label className="field-label" htmlFor="send-time-reference">
            Start searching after
          </label>
          <input
            id="send-time-reference"
            type="datetime-local"
            className="input"
            value={referenceAt}
            onChange={(event) => setReferenceAt(event.target.value)}
          />
          <span className="stx-field-note">
            Blank starts from the current time on the server.
          </span>
        </div>
      </div>

      <SchedulePreview state={preview} />

      {scheduleError ? (
        <div className="stx-inline-warning is-danger" role="alert">
          {scheduleError}
        </div>
      ) : null}

      {reviewing && preview.kind === "ready" ? (
        <div
          className="stx-activation-review"
          role="region"
          aria-label="Activation review"
        >
          <strong>Confirm this delivery change</strong>
          <p>
            This will replace recipient schedule timestamps for{" "}
            {preview.data.scheduled.toLocaleString()} recipients using the
            previewed strategy. Re-check the campaign if its audience changed
            after {formatAbsoluteDate(preview.data.counted_at)}.
          </p>
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              onClick={() => setReviewing(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting}
              onClick={() => void submitSchedule()}
            >
              {submitting ? "Activating…" : "Confirm durable schedule"}
            </button>
          </div>
        </div>
      ) : (
        <div className="stx-schedule-action">
          <span>
            {!canWrite
              ? "Your current role can preview, but cannot activate schedules."
              : "Activation requires a fresh successful preview."}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canWrite || preview.kind !== "ready" || submitting}
            onClick={requestReview}
          >
            Review activation
          </button>
        </div>
      )}

      {lastResult ? <ScheduleResult result={lastResult} /> : null}
    </section>
  );
}

function SchedulingReadiness(): ReactElement {
  return (
    <section
      className="stx-tool-card stx-readiness"
      aria-labelledby="send-time-schedule-title"
    >
      <div className="stx-tool-heading">
        <span className="stx-tool-icon" aria-hidden="true">
          <Icon name="shield-check" size={17} />
        </span>
        <div>
          <div className="stx-kicker">Activation readiness</div>
          <h2 id="send-time-schedule-title">Delivery changes stay locked</h2>
          <p>
            Analysis is usable now. Campaign mutation remains deliberately
            unavailable until durable delivery and recovery are release
            qualified.
          </p>
        </div>
        <span className="stx-status-chip is-neutral">Read only</span>
      </div>

      <div className="stx-readiness-steps">
        <ReadinessStep
          status="ready"
          title="Analyze audiences"
          copy="Measured segment patterns and individual cached recommendations."
        />
        <ReadinessStep
          status="review"
          title="Verify dry-run parity"
          copy="Preview and commit must share the same audience snapshot and constraints."
        />
        <ReadinessStep
          status="blocked"
          title="Qualify durable recovery"
          copy="Retry, cancellation, restart recovery, and audit evidence must all pass."
        />
      </div>

      <div className="stx-readiness-footer">
        <p>{CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setSection("campaigns")}
        >
          Review campaign drafts
          <Icon name="arrow-up-right" size={13} />
        </button>
      </div>
    </section>
  );
}

function ReadinessStep({
  status,
  title,
  copy,
}: {
  status: "ready" | "review" | "blocked";
  title: string;
  copy: string;
}): ReactElement {
  return (
    <div className={`stx-readiness-step is-${status}`}>
      <span className="stx-readiness-marker" aria-hidden="true">
        {status === "ready" ? "✓" : status === "review" ? "2" : "3"}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{copy}</p>
      </div>
    </div>
  );
}

function SchedulePreview({
  state,
}: {
  state: PreviewState;
}): ReactElement | null {
  if (state.kind === "idle") return null;
  if (state.kind === "loading") {
    return (
      <div className="stx-preview-loading" role="status">
        <span className="skel" />
        <span className="skel" />
        <span className="visually-hidden">Calculating delivery preview.</span>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="stx-inline-warning is-danger" role="alert">
        Dry-run preview failed: {state.message}
      </div>
    );
  }
  const preview = state.data;
  const max = Math.max(
    1,
    ...preview.distribution.map((bucket) => bucket.count),
  );
  return (
    <section className="stx-preview" aria-labelledby="send-time-preview-title">
      <div className="stx-preview-heading">
        <div>
          <div className="stx-kicker">Fresh dry run</div>
          <h3 id="send-time-preview-title">Recipient distribution</h3>
        </div>
        <span>{formatAbsoluteDate(preview.counted_at)}</span>
      </div>
      <div className="stx-preview-facts">
        <span>
          <strong>{preview.scheduled.toLocaleString()}</strong> recipients
        </span>
        <span>
          <strong>{preview.max_per_minute.toLocaleString()}</strong> busiest
          minute
        </span>
        <span>
          <strong>{preview.max_per_day.toLocaleString()}</strong> busiest day
        </span>
      </div>
      {preview.warmup_cap_breach ? (
        <div className="stx-inline-warning is-danger" role="alert">
          The peak day exceeds today’s warm-up cap of{" "}
          {preview.tier_cap_today.toLocaleString()} recipients.
        </div>
      ) : null}
      <div className="stx-preview-chart" aria-hidden="true">
        {preview.distribution.map((bucket) => (
          <span
            key={bucket.hour}
            style={{ "--stx-bar": bucket.count / max } as React.CSSProperties}
            title={`${bucket.hour}:00 UTC · ${bucket.count.toLocaleString()} recipients`}
          />
        ))}
      </div>
      <details className="stx-preview-data">
        <summary>View accessible hourly data</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">UTC hour</th>
              <th scope="col">Recipients</th>
            </tr>
          </thead>
          <tbody>
            {preview.distribution.map((bucket) => (
              <tr key={bucket.hour}>
                <th scope="row">{String(bucket.hour).padStart(2, "0")}:00</th>
                <td>{bucket.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function ScheduleResult({
  result,
}: {
  result: ScheduleByBestTimeResponse;
}): ReactElement {
  return (
    <div className="stx-schedule-result" role="status">
      <div>
        <Icon name="shield-check" size={17} />
        <strong>
          Durable schedule confirmed for {result.scheduled.toLocaleString()}{" "}
          recipients
        </strong>
      </div>
      <p>
        Recipient addresses remain protected. Review aggregate delivery
        distribution and campaign audit history for verification.
      </p>
    </div>
  );
}
