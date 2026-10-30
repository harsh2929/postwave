import type { ReactElement } from "react";

import { Icon } from "../Icon";
import type { useSendTimeWorkspaceSetting } from "./useSendTimeControllers";

type Controller = ReturnType<typeof useSendTimeWorkspaceSetting>;

export function SendTimeWorkspacePolicy({
  canAdmin,
  controller,
}: {
  canAdmin: boolean;
  controller: Controller;
}): ReactElement {
  const { state, saving, load, setEnabled } = controller;
  const ready = state.kind === "ready";
  const enabled = ready && state.enabled;

  return (
    <section
      className="stx-policy"
      aria-labelledby="send-time-policy-title"
      aria-busy={state.kind === "loading" || saving || undefined}
      data-testid="sto-settings-card"
    >
      <div className="stx-policy-heading">
        <span className="stx-policy-icon" aria-hidden="true">
          <Icon name="shield-check" size={16} />
        </span>
        <div>
          <div className="stx-kicker">Workspace policy</div>
          <h2 id="send-time-policy-title" className="stx-policy-title">
            New-campaign default
          </h2>
        </div>
        <span
          className={`stx-status-chip ${
            state.kind === "error"
              ? "is-danger"
              : enabled
                ? "is-positive"
                : "is-neutral"
          }`}
        >
          <span className="stx-status-dot" aria-hidden="true" />
          {state.kind === "loading"
            ? "Checking"
            : state.kind === "error"
              ? "Unavailable"
              : enabled
                ? "Enabled"
                : "Disabled"}
        </span>
      </div>

      <p className="stx-policy-copy">
        {state.kind === "loading"
          ? "Reading the server-owned workspace setting."
          : state.kind === "error"
            ? "The default could not be verified. New campaigns must not be assumed to inherit personalized timing."
            : enabled
              ? "New campaigns start with a 24-hour personalized delivery window. Existing campaigns and analysis are unchanged."
              : "New campaigns do not automatically start with a personalized delivery window. Existing campaigns and analysis are unchanged."}
      </p>

      {state.kind === "error" ? (
        <div className="stx-policy-error" role="alert">
          <span>{state.message}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="stx-policy-footer">
          <span className="stx-policy-authority">
            {canAdmin
              ? "Admin control · applies to every operator"
              : "Read only · an admin controls this setting"}
          </span>
          {canAdmin ? (
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Use a personalized delivery window by default for new campaigns"
              className={`stx-switch${enabled ? " is-on" : ""}`}
              disabled={!ready || saving}
              onClick={() => void setEnabled(!enabled)}
            >
              <span className="stx-switch-track" aria-hidden="true">
                <span className="stx-switch-thumb" />
              </span>
              <span>{saving ? "Saving…" : enabled ? "On" : "Off"}</span>
            </button>
          ) : (
            <span className="stx-readonly-lock">
              <Icon name="lock" size={13} />
              Protected
            </span>
          )}
        </div>
      )}
    </section>
  );
}
