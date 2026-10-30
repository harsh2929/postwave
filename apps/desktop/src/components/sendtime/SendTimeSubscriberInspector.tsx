import type { KeyboardEvent, ReactElement } from "react";

import { STO_MIN_OPENS_DEFAULT } from "../../lib/api-client";
import { setSection } from "../../lib/store";
import { Icon } from "../Icon";
import { SendTimeHeatmap } from "./SendTimeHeatmap";
import {
  decomposeHourOfWeek,
  formatAbsoluteDate,
  formatHour,
  formatRelativeDate,
  maskEmail,
} from "./model";
import type { useSubscriberSendTimeLookup } from "./useSendTimeControllers";

type Controller = ReturnType<typeof useSubscriberSendTimeLookup>;

export function SendTimeSubscriberInspector({
  controller,
}: {
  controller: Controller;
}): ReactElement {
  const { lookupId, setLookupId, inputError, state, submit, clear } =
    controller;
  const busy = state.kind === "loading";

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <section
      className="stx-tool-card stx-inspector"
      aria-labelledby="send-time-inspector-title"
      aria-busy={busy || undefined}
    >
      <div className="stx-tool-heading">
        <span className="stx-tool-icon" aria-hidden="true">
          <Icon name="users" size={17} />
        </span>
        <div>
          <div className="stx-kicker">Inspect</div>
          <h2 id="send-time-inspector-title">Subscriber recommendation</h2>
          <p>
            Validate one cached recommendation without exposing the full
            subscriber record.
          </p>
        </div>
        <span className="stx-privacy-chip">
          <Icon name="lock" size={12} />
          Confidential
        </span>
      </div>

      <div className="stx-inspector-form">
        <div className="field">
          <label className="field-label" htmlFor="send-time-subscriber-id">
            Subscriber UUID
          </label>
          <div className="stx-lookup-row">
            <div className="stx-input-shell">
              <Icon name="key" size={14} />
              <input
                id="send-time-subscriber-id"
                name="subscriber_id"
                className="input"
                value={lookupId}
                placeholder="00000000-0000-0000-0000-000000000000"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                aria-invalid={inputError ? true : undefined}
                aria-describedby={
                  inputError
                    ? "send-time-subscriber-error"
                    : "send-time-subscriber-help"
                }
                onChange={(event) => setLookupId(event.target.value)}
                onKeyDown={submitOnEnter}
              />
              {lookupId ? (
                <button
                  type="button"
                  className="stx-input-clear"
                  aria-label="Clear subscriber lookup"
                  onClick={clear}
                >
                  <Icon name="x" size={13} />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "Inspecting…" : "Inspect"}
            </button>
          </div>
          {inputError ? (
            <span
              id="send-time-subscriber-error"
              className="stx-field-error"
              role="alert"
            >
              {inputError}
            </span>
          ) : (
            <span id="send-time-subscriber-help" className="stx-field-note">
              The analysis endpoint accepts a UUID, not an email address.
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm stx-find-subscriber"
          onClick={() => setSection("subscribers")}
        >
          Find a subscriber
          <Icon name="arrow-up-right" size={13} />
        </button>
      </div>

      <div className="stx-inspector-result" aria-live="polite">
        <SubscriberResult controller={controller} />
      </div>
    </section>
  );
}

function SubscriberResult({
  controller,
}: {
  controller: Controller;
}): ReactElement {
  const { state, submit } = controller;
  if (state.kind === "idle") {
    return (
      <div className="stx-inspector-empty">
        <span className="stx-empty-glyph" aria-hidden="true">
          <Icon name="clock" size={20} />
        </span>
        <div>
          <strong>Ready for a precise lookup</strong>
          <p>
            The result will show the cached UTC window, model recency, and a
            weekly pattern when detailed signal is available.
          </p>
        </div>
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="stx-inspector-loading" role="status">
        <div className="skel" />
        <div className="skel" />
        <div className="skel" />
        <span className="visually-hidden">
          Loading subscriber send-time recommendation.
        </span>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="stx-lookup-notice is-danger" role="alert">
        <Icon name="alert-triangle" size={17} />
        <div>
          <strong>Recommendation unavailable</strong>
          <p>{state.message}</p>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void submit()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (state.kind === "cold") {
    return (
      <div className="stx-lookup-notice" role="status">
        <Icon name="chart-bars" size={17} />
        <div>
          <strong>Still learning this subscriber’s rhythm</strong>
          <p>
            No cached best window exists yet. The current model needs at least{" "}
            {STO_MIN_OPENS_DEFAULT} qualifying engagement events before it can
            calculate an individual recommendation.
          </p>
          <span className="stx-result-id">
            Checked subscriber …{state.lookupKey.slice(-8)}
          </span>
        </div>
      </div>
    );
  }

  const { recommendation, pattern } = state;
  const { weekday, hourOfDay } = decomposeHourOfWeek(
    recommendation.best_hour_utc,
  );
  const sampleSize =
    pattern && pattern.sample_size > 0
      ? pattern.sample_size
      : recommendation.sample_size > 0
        ? recommendation.sample_size
        : null;
  const protectedEmail = maskEmail(recommendation.email);

  return (
    <div className="stx-subscriber-ready">
      <div className="stx-subscriber-summary">
        <div className="stx-window-primary">
          <span className="stx-kicker">Recommended UTC window</span>
          <strong>{formatHour(hourOfDay)}</strong>
          <span>{weekday}</span>
        </div>
        <div className="stx-subscriber-facts">
          <div>
            <span>Signal analyzed</span>
            <strong>
              {sampleSize == null
                ? "Not reported"
                : `${sampleSize.toLocaleString()} events`}
            </strong>
          </div>
          <div>
            <span>Last computed</span>
            <strong title={formatAbsoluteDate(recommendation.computed_at)}>
              {formatRelativeDate(recommendation.computed_at)}
            </strong>
          </div>
          <div>
            <span>Identity</span>
            <strong>{protectedEmail ?? `…${state.lookupKey.slice(-8)}`}</strong>
          </div>
        </div>
      </div>

      {state.patternWarning ? (
        <div className="stx-inline-warning" role="status">
          The scalar recommendation loaded, but its detailed weekly pattern did
          not: {state.patternWarning}
        </div>
      ) : null}

      {pattern ? (
        <div className="stx-subscriber-heatmap">
          <SendTimeHeatmap
            compact
            title="Weekly engagement pattern"
            hint={`Trailing 180 days · up to 2,000 events · ${pattern.sample_size.toLocaleString()} used`}
            grid={pattern.grid}
            primary={{ dow: pattern.best_dow, hour: pattern.best_hour }}
            {...(pattern.bimodal &&
            pattern.secondary_dow != null &&
            pattern.secondary_hour != null
              ? {
                  secondary: {
                    dow: pattern.secondary_dow,
                    hour: pattern.secondary_hour,
                  },
                }
              : {})}
            provenance={{
              source: "Moosewave subscriber engagement-pattern API",
              asOf: pattern.computed_at ?? recommendation.computed_at,
              scope:
                "Selected subscriber · trailing 180 days · displayed timezone",
              note: `${pattern.sample_size.toLocaleString()} weighted opens, clicks, or replies were used; raw buckets are UTC.`,
            }}
            exportFileName="subscriber-send-time-pattern.csv"
            exportPrivacy="confidential"
          />
        </div>
      ) : (
        <p className="stx-pattern-absent">
          A detailed weekly distribution was not returned. The cached UTC
          recommendation above remains available, but its shape cannot be
          inspected from this response.
        </p>
      )}
    </div>
  );
}
