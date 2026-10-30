/**
 * SendSettingsPanel — the first UI for the tenant send-settings surface
 * (apps/api/internal/handlers/send_settings.go, backed by tenant_send_settings).
 * The backend shipped GET + PUT to pin a workspace-wide send-time-optimization
 * default (so /campaigns/{id}/schedule-by-best-time can fall back to it) plus a
 * "force per-recipient for newsletters" toggle — but no client ever called it,
 * so operators couldn't see what their workspace default was. This surfaces it.
 *
 * Read-first: the mutating method (update) exists on the client (sendSettingsApi),
 * but the gap this closes is visibility, so the panel starts by showing the
 * current default and the newsletter rule.
 */
import { useEffect, useState } from "react";

import { sendSettingsApi } from "../../lib/api-client";
import type { SendSettings, STOStrategy } from "../../lib/api/send-settings";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; settings: SendSettings };

// Operator-facing label + one-line explanation for each strategy value.
function strategyCopy(strategy: STOStrategy): { label: string; hint: string } {
  switch (strategy) {
    case "modal_hour":
      return {
        label: "Modal hour",
        hint: "Send to everyone at the single best hour for the whole audience.",
      };
    case "per_recipient":
      return {
        label: "Per recipient",
        hint: "Optimize the send time individually for each recipient.",
      };
    case "none":
    default:
      return {
        label: "No workspace default",
        hint: "Each campaign chooses its own send-time strategy; nothing is pinned.",
      };
  }
}

export function SendSettingsPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    sendSettingsApi
      .get()
      .then((res) => {
        if (!alive) return;
        setState(
          res.error
            ? { kind: "error", message: res.error.message }
            : { kind: "ready", settings: res.data },
        );
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Unexpected request error",
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section
      aria-label="Send defaults"
      style={{ display: "grid", gap: 12, padding: 12 }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 14 }}>Send defaults</h3>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          The workspace-wide send-time strategy campaigns fall back to when they
          don’t set their own.
        </p>
      </header>

      {state.kind === "loading" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="skel" style={{ height: 12, width: "45%" }} />
          <div className="skel" style={{ height: 12, width: "70%" }} />
        </div>
      ) : null}

      {state.kind === "error" ? (
        <p
          role="alert"
          className="muted"
          style={{ fontSize: 12, margin: 0, color: "var(--pw-danger)" }}
        >
          Couldn’t load send defaults: {state.message}
        </p>
      ) : null}

      {state.kind === "ready" ? (
        <SettingsView settings={state.settings} />
      ) : null}
    </section>
  );
}

function SettingsView({ settings }: { settings: SendSettings }) {
  const copy = strategyCopy(settings.default_sto_strategy);
  const pinned = settings.default_sto_strategy !== "none";

  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: 8,
      }}
    >
      <li
        style={{
          border: "1px solid var(--pw-border)",
          borderRadius: "var(--pw-radius-md, 8px)",
          background: "var(--pw-bg-elev)",
          padding: "10px 12px",
          display: "grid",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600 }}>Default send-time strategy</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "1px 8px",
              borderRadius: "var(--pw-radius-pill, 999px)",
              color: pinned ? "var(--pw-success)" : "var(--pw-fg-muted)",
              background: "color-mix(in srgb, currentColor 16%, transparent)",
              marginLeft: "auto",
            }}
          >
            {copy.label}
          </span>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {copy.hint}
        </span>
      </li>

      <li
        style={{
          border: "1px solid var(--pw-border)",
          borderRadius: "var(--pw-radius-md, 8px)",
          background: "var(--pw-bg-elev)",
          padding: "10px 12px",
          display: "grid",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600 }}>
            Force per-recipient for newsletters
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "1px 8px",
              borderRadius: "var(--pw-radius-pill, 999px)",
              color: settings.newsletters_force_per_recipient
                ? "var(--pw-success)"
                : "var(--pw-fg-muted)",
              background: "color-mix(in srgb, currentColor 16%, transparent)",
              marginLeft: "auto",
            }}
          >
            {settings.newsletters_force_per_recipient ? "On" : "Off"}
          </span>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {settings.newsletters_force_per_recipient
            ? "Newsletter-type campaigns are automatically switched to per-recipient send times."
            : "Newsletter-type campaigns use whatever send-time strategy they’re given."}
        </span>
      </li>
    </ul>
  );
}
