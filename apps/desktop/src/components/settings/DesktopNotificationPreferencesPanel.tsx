import { type ReactElement, useState } from "react";

import {
  updateDesktopNotificationPreferences,
  useNotificationCenter,
  type DesktopNotificationTopic,
} from "../../lib/notification-center";
import { tauriApi } from "../../lib/tauri";

function minuteToTime(minute: number): string {
  const normalized = Math.max(0, Math.min(1439, Math.round(minute)));
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(
    normalized % 60,
  ).padStart(2, "0")}`;
}

function timeToMinute(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? hour * 60 + minute
    : null;
}

function DesktopToggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <div className="settings-toggle-row">
      <label htmlFor={id} className="settings-toggle-label" aria-label={label}>
        <span>
          <span className="settings-toggle-title">{label}</span>
          <span className="settings-toggle-hint">{hint}</span>
        </span>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="settings-toggle-input"
          role="switch"
          aria-checked={checked}
        />
      </label>
    </div>
  );
}

export function DesktopNotificationPreferencesPanel(): ReactElement {
  const center = useNotificationCenter();
  const [probe, setProbe] = useState<
    "idle" | "checking" | "ok" | "denied" | "failed"
  >("idle");

  const sendTest = async (): Promise<void> => {
    setProbe("checking");
    try {
      const permission = await tauriApi.requestNotificationPermission();
      if (permission !== "granted") {
        throw new Error(
          permission === "denied"
            ? "notifications_permission_denied"
            : "notifications_unavailable",
        );
      }
      await tauriApi.showNotification({
        title: "Moosewave notifications enabled",
        body: "Desktop alerts use privacy-safe copy. Full details stay inside Moosewave.",
      });
      setProbe("ok");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.toLowerCase() : "";
      setProbe(
        /(permission|denied|not allowed|authori[sz]ation)/u.test(message)
          ? "denied"
          : "failed",
      );
    }
  };

  const toggleChannel = (enabled: boolean): void => {
    updateDesktopNotificationPreferences({ osEnabled: enabled });
    if (enabled) void sendTest();
    else setProbe("idle");
  };

  const setTopic = (
    topic: DesktopNotificationTopic,
    enabled: boolean,
  ): void => {
    updateDesktopNotificationPreferences({
      topics: { ...center.preferences.topics, [topic]: enabled },
    });
  };

  return (
    <div className="desktop-notification-settings">
      <div className="desktop-notification-settings-head">
        <div>
          <h3 className="settings-subhead">Desktop delivery</h3>
          <p className="settings-toggle-hint">
            Lock-screen copy never includes campaign names, subjects, addresses,
            people, metrics, or workspace details.
          </p>
        </div>
        <button
          type="button"
          className={
            center.preferences.osEnabled
              ? "btn btn-secondary"
              : "btn btn-primary"
          }
          disabled={center.identity !== "ready" || probe === "checking"}
          onClick={() => toggleChannel(!center.preferences.osEnabled)}
        >
          {probe === "checking"
            ? "Checking permission…"
            : center.preferences.osEnabled
              ? "Disable desktop alerts"
              : "Enable desktop alerts"}
        </button>
      </div>

      {probe === "ok" ? (
        <div className="alert alert-success" role="status">
          Test alert requested. Confirm that it appeared; otherwise review
          Moosewave in the operating system&apos;s notification settings.
        </div>
      ) : probe === "denied" ? (
        <div className="alert alert-error" role="alert">
          The operating system denied notification permission. Allow Moosewave in
          system notification settings, then send another test.
        </div>
      ) : probe === "failed" ? (
        <div className="alert alert-error" role="alert">
          The test alert could not be delivered. Notification Center will still
          retain the event so it is not lost.
        </div>
      ) : null}

      {center.persistError ? (
        <div className="alert alert-error" role="alert">
          Encrypted notification preferences could not be saved. Unlock the
          device keychain before relying on these settings after restart.
        </div>
      ) : null}

      <fieldset className="desktop-notification-topics">
        <legend>Alert topics</legend>
        <DesktopToggle
          id="desktop-notif-approval"
          label="Approval requested"
          hint="A campaign needs a decision. Details remain in Moosewave."
          checked={center.preferences.topics["approval.requested"]}
          onChange={(enabled) => setTopic("approval.requested", enabled)}
        />
        <DesktopToggle
          id="desktop-notif-campaign"
          label="Campaign sent"
          hint="A send finished and delivery details are ready."
          checked={center.preferences.topics["campaign.sent"]}
          onChange={(enabled) => setTopic("campaign.sent", enabled)}
        />
        <DesktopToggle
          id="desktop-notif-bounce"
          label="Subscriber bounced"
          hint="A deliverability event needs review; no address appears on the lock screen."
          checked={center.preferences.topics["subscriber.bounced"]}
          onChange={(enabled) => setTopic("subscriber.bounced", enabled)}
        />
        <DesktopToggle
          id="desktop-notif-anomaly"
          label="Dashboard anomaly"
          hint="A workspace metric needs investigation; metric names and values stay in the app."
          checked={center.preferences.topics["dashboard.anomaly"]}
          onChange={(enabled) => setTopic("dashboard.anomaly", enabled)}
        />
        <DesktopToggle
          id="desktop-notif-milestone"
          label="Audience milestone"
          hint="Celebrate a newly crossed growth milestone. Off by default."
          checked={center.preferences.topics["dashboard.milestone"]}
          onChange={(enabled) => setTopic("dashboard.milestone", enabled)}
        />
      </fieldset>

      <div className="desktop-notification-grid">
        <div className="field">
          <label className="field-label" htmlFor="desktop-notif-foreground">
            While Moosewave is active
          </label>
          <select
            id="desktop-notif-foreground"
            className="input"
            value={center.preferences.foregroundPolicy}
            onChange={(event) =>
              updateDesktopNotificationPreferences({
                foregroundPolicy:
                  event.target.value === "os-and-center"
                    ? "os-and-center"
                    : "center-only",
              })
            }
          >
            <option value="center-only">Notification Center only</option>
            <option value="os-and-center">Also show an OS alert</option>
          </select>
          <div className="field-hint">
            The default avoids duplicate interruption when you are already using
            the app.
          </div>
        </div>

        <div className="desktop-notification-quiet">
          <DesktopToggle
            id="desktop-notif-quiet"
            label="Quiet hours"
            hint="Keep events in Notification Center without an OS alert."
            checked={center.preferences.quietHours.enabled}
            onChange={(enabled) =>
              updateDesktopNotificationPreferences({
                quietHours: { ...center.preferences.quietHours, enabled },
              })
            }
          />
          <div className="desktop-notification-times">
            <label className="field-label" htmlFor="desktop-notif-quiet-start">
              From
            </label>
            <input
              id="desktop-notif-quiet-start"
              className="input"
              type="time"
              value={minuteToTime(center.preferences.quietHours.startMinute)}
              disabled={!center.preferences.quietHours.enabled}
              onChange={(event) => {
                const minute = timeToMinute(event.target.value);
                if (minute === null) return;
                updateDesktopNotificationPreferences({
                  quietHours: {
                    ...center.preferences.quietHours,
                    startMinute: minute,
                  },
                });
              }}
            />
            <label className="field-label" htmlFor="desktop-notif-quiet-end">
              Until
            </label>
            <input
              id="desktop-notif-quiet-end"
              className="input"
              type="time"
              value={minuteToTime(center.preferences.quietHours.endMinute)}
              disabled={!center.preferences.quietHours.enabled}
              onChange={(event) => {
                const minute = timeToMinute(event.target.value);
                if (minute === null) return;
                updateDesktopNotificationPreferences({
                  quietHours: {
                    ...center.preferences.quietHours,
                    endMinute: minute,
                  },
                });
              }}
            />
          </div>
          {center.preferences.quietHours.enabled &&
          center.preferences.quietHours.startMinute ===
            center.preferences.quietHours.endMinute ? (
            <div className="field-hint">
              Matching start and end times keep OS alerts quiet all day.
            </div>
          ) : null}
        </div>
      </div>

      {center.preferences.osEnabled ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={probe === "checking"}
          onClick={() => void sendTest()}
        >
          Send test alert
        </button>
      ) : null}
    </div>
  );
}
