import type { ReactElement } from "react";

import {
  type DesktopCloseBehavior,
  recommendedDesktopCloseBehavior,
  setDesktopCloseBehavior,
  useDesktopWindowLifecycleState,
} from "../../lib/desktop-window-lifecycle";

const OPTIONS: ReadonlyArray<{
  value: DesktopCloseBehavior;
  label: string;
  detail: string;
}> = [
  {
    value: "ask",
    label: "Ask every time",
    detail: "Show the close explanation before hiding or quitting.",
  },
  {
    value: "hide",
    label: "Keep running in the tray",
    detail:
      "Hide the window while sync, uploads, and background monitoring continue.",
  },
  {
    value: "quit",
    label: "Quit Moosewave",
    detail:
      "Stop the desktop process after the lifecycle safety check completes.",
  },
];

export function DesktopWindowSettings(): ReactElement {
  const lifecycle = useDesktopWindowLifecycleState();
  const recommended = recommendedDesktopCloseBehavior(lifecycle.platform);
  return (
    <section className="settings-section" data-settings-anchor="desktop-window">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Desktop window</h2>
        <div className="settings-section-sub">
          Choose what the title-bar close control and Cmd/Ctrl+W do.
        </div>
      </div>
      <div className="settings-section-body">
        <fieldset className="field" style={{ border: 0, padding: 0 }}>
          <legend className="label">When I close the main window</legend>
          {OPTIONS.map((option) => (
            <label
              className="settings-row radio-row"
              key={option.value}
              htmlFor={`desktop-close-${option.value}`}
              aria-label={option.label}
            >
              <input
                id={`desktop-close-${option.value}`}
                type="radio"
                name="desktop-close-behavior"
                value={option.value}
                checked={lifecycle.closeBehavior === option.value}
                onChange={() => setDesktopCloseBehavior(option.value)}
              />
              <span>
                <span>
                  {option.label}
                  {option.value === recommended ? (
                    <span className="badge success" style={{ marginLeft: 8 }}>
                      Recommended for this platform
                    </span>
                  ) : null}
                </span>
                <span
                  className="muted"
                  style={{ display: "block", fontSize: 12 }}
                >
                  {option.detail}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="notice" role="note">
          Quit, sign out, workspace switch, update restart, and OS shutdown
          always use the same draft, transfer, and sync-journal safety check.
          Window size and position are restored on the next launch.
        </div>
      </div>
    </section>
  );
}
