/**
 * MaintenanceWindowsPanel — the first UI for scheduled maintenance windows
 * (apps/api/internal/maintenance). A tenant admin schedules a window (title,
 * affected components, time range) that the platform surfaces/governs — full
 * CRUD across 4 routes, but no client. This lists the windows with their state
 * (upcoming / active / past derived from the time range) and affected components.
 *
 * Read-first: create/edit/cancel exist on the client for the editor that
 * follows; the gap this closes is visibility.
 */
import { useEffect, useState } from "react";

import { maintenanceWindowsApi } from "../../lib/api-client";
import type { MaintenanceWindow } from "../../lib/api/maintenance-windows";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; windows: MaintenanceWindow[] };

// phaseOf derives a human phase from the window's time range + status.
function phaseOf(w: MaintenanceWindow): { label: string; color: string } {
  if (w.status && w.status.toLowerCase() === "cancelled") {
    return { label: "cancelled", color: "var(--pw-fg-muted)" };
  }
  const now = Date.now();
  const start = new Date(w.starts_at).getTime();
  const end = new Date(w.ends_at).getTime();
  if (now < start) return { label: "upcoming", color: "var(--pw-info)" };
  if (now > end) return { label: "past", color: "var(--pw-fg-muted)" };
  return { label: "active", color: "var(--pw-warning)" };
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function MaintenanceWindowsPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    maintenanceWindowsApi
      .list()
      .then((res) => {
        if (!alive) return;
        setState(
          res.error
            ? { kind: "error", message: res.error.message }
            : { kind: "ready", windows: res.data },
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
      aria-label="Maintenance windows"
      style={{ display: "grid", gap: 12, padding: 12 }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 14 }}>Maintenance windows</h3>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          Scheduled windows and the components they affect.
        </p>
      </header>

      {state.kind === "loading" ? (
        <div className="skel" style={{ height: 12, width: "55%" }} />
      ) : null}
      {state.kind === "error" ? (
        <p
          role="alert"
          className="muted"
          style={{ fontSize: 12, margin: 0, color: "var(--pw-danger)" }}
        >
          Couldn’t load maintenance windows: {state.message}
        </p>
      ) : null}
      {state.kind === "ready" && state.windows.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          No maintenance windows scheduled.
        </p>
      ) : null}

      {state.kind === "ready" && state.windows.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: 8,
          }}
        >
          {state.windows.map((w) => {
            const phase = phaseOf(w);
            return (
              <li
                key={w.id}
                style={{
                  border: "1px solid var(--pw-border)",
                  borderRadius: "var(--pw-radius-md, 8px)",
                  background: "var(--pw-bg-elev)",
                  padding: "10px 12px",
                  display: "grid",
                  gap: 4,
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
                  <span style={{ fontWeight: 600 }}>{w.title}</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "1px 8px",
                      borderRadius: "var(--pw-radius-pill, 999px)",
                      color: phase.color,
                      background:
                        "color-mix(in srgb, currentColor 16%, transparent)",
                    }}
                  >
                    {phase.label}
                  </span>
                  <span
                    className="muted"
                    style={{ fontSize: 12, marginLeft: "auto" }}
                  >
                    {fmt(w.starts_at)} → {fmt(w.ends_at)}
                  </span>
                </div>
                {w.description ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {w.description}
                  </span>
                ) : null}
                {w.components.length > 0 ? (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {w.components.map((c) => (
                      <span
                        key={c}
                        style={{
                          fontSize: 11,
                          padding: "0 6px",
                          borderRadius: 4,
                          background:
                            "color-mix(in srgb, var(--pw-fg-muted) 14%, transparent)",
                          color: "var(--pw-fg-muted)",
                        }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
