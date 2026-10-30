import type { ReactElement } from "react";

import {
  checkForDesktopUpdate,
  clearDesktopUpdateReminder,
  deferDesktopUpdate,
  installDesktopUpdate,
  requestDesktopUpdateRestart,
  retryDesktopUpdate,
  useDesktopUpdateState,
  type DesktopUpdatePhase,
} from "../../lib/desktop-update-service";
import { toast } from "../Toast";
import { SettingsSectionHeader } from "./SettingsNav";

export function DesktopUpdateSettings(): ReactElement {
  const update = useDesktopUpdateState();
  const busy =
    update.phase === "checking" ||
    update.phase === "downloading" ||
    update.phase === "installing";
  const percent =
    update.totalBytes && update.totalBytes > 0
      ? Math.min(
          100,
          Math.round((update.downloadedBytes / update.totalBytes) * 100),
        )
      : null;

  return (
    <section
      id="desktop-updates"
      className="settings-section desktop-update-settings"
      aria-labelledby="desktop-updates-title"
    >
      <SettingsSectionHeader
        title="Desktop updates"
        description="Signed Moosewave releases, download progress, and restart readiness."
        meta={
          update.currentVersion ? (
            <span className="mono muted">Current v{update.currentVersion}</span>
          ) : undefined
        }
      />
      <div className="settings-section-body">
        <div className="desktop-update-summary">
          <div>
            <div className="desktop-update-status-line" aria-live="polite">
              <span
                id="desktop-updates-title"
                className="desktop-update-status-title"
              >
                {phaseTitle(update.phase, update.latestVersion)}
              </span>
              {update.phase === "available" ||
              update.phase === "ready_to_restart" ? (
                <span className={`badge ${severityClass(update.severity)}`}>
                  {severityLabel(update.severity)}
                </span>
              ) : null}
            </div>
            <div className="desktop-update-meta">
              {phaseDetail(update.phase)}
              {update.lastCheckedAt !== null ? (
                <>
                  {" "}
                  Last checked {formatDateTime(update.lastCheckedAt)}
                  {update.checkSource === "scheduled"
                    ? " automatically"
                    : " manually"}
                  .
                </>
              ) : null}
              {update.publishedAt ? (
                <> Released {formatDateTime(update.publishedAt)}.</>
              ) : null}
            </div>
          </div>

          <div className="desktop-update-actions">
            {update.phase === "available" ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void installDesktopUpdate()}
                >
                  Install v{update.latestVersion ?? "update"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setReminder(4 * 60 * 60 * 1000, "four hours")}
                >
                  Remind in 4 hours
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setReminder(24 * 60 * 60 * 1000, "tomorrow")}
                >
                  Tomorrow
                </button>
                {update.error && update.lastFailedOperation === "check" ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void checkForDesktopUpdate()}
                  >
                    Retry check
                  </button>
                ) : null}
              </>
            ) : update.phase === "ready_to_restart" ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void requestDesktopUpdateRestart()}
                >
                  Review &amp; restart
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setReminder(4 * 60 * 60 * 1000, "four hours")}
                >
                  Restart later
                </button>
              </>
            ) : update.phase === "error" ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void retryDesktopUpdate()}
              >
                {update.lastFailedOperation === "install"
                  ? "Retry installation"
                  : "Retry check"}
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => void checkForDesktopUpdate()}
                disabled={busy}
              >
                {update.phase === "checking" ? "Checking…" : "Check now"}
              </button>
            )}
          </div>
        </div>

        {update.phase === "downloading" || update.phase === "installing" ? (
          <div className="desktop-update-progress">
            <div
              className="desktop-update-progress-track"
              role="progressbar"
              aria-label={
                update.phase === "installing"
                  ? "Verifying and installing update"
                  : "Downloading update"
              }
              aria-valuemin={percent === null ? undefined : 0}
              aria-valuemax={percent === null ? undefined : 100}
              aria-valuenow={percent ?? undefined}
              aria-valuetext={
                percent === null
                  ? "Progress unavailable"
                  : `${percent}% downloaded`
              }
            >
              <div
                className={`desktop-update-progress-value${
                  percent === null ? " is-indeterminate" : ""
                }`}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
            <div className="desktop-update-progress-copy">
              <span>
                {update.phase === "installing"
                  ? "Verifying signature and installing…"
                  : "Downloading signed update…"}
              </span>
              <span>
                {progressLabel(
                  update.downloadedBytes,
                  update.totalBytes,
                  percent,
                )}
              </span>
            </div>
          </div>
        ) : null}

        {update.error ? (
          <div className="desktop-update-error" role="alert">
            <strong>
              {update.phase === "available" ||
              update.phase === "ready_to_restart"
                ? "The latest background check failed. The verified update state above is retained."
                : "Update operation failed."}
            </strong>{" "}
            {update.error}
          </div>
        ) : null}

        {update.snoozedUntil !== null && update.snoozedUntil > Date.now() ? (
          <div className="desktop-update-reminder">
            Reminder paused until {formatDateTime(update.snoozedUntil)}.{" "}
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={clearDesktopUpdateReminder}
            >
              Resume reminders
            </button>
          </div>
        ) : null}

        {update.releaseNotes && update.latestVersion ? (
          <div className="desktop-update-release-notes">
            <h3>What&apos;s new in v{update.latestVersion}</h3>
            <pre>{update.releaseNotes}</pre>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function setReminder(milliseconds: number, label: string): void {
  deferDesktopUpdate(milliseconds);
  toast.info(`Update reminder set for ${label}`);
}

function phaseTitle(
  phase: DesktopUpdatePhase,
  latestVersion: string | null,
): string {
  switch (phase) {
    case "checking":
      return "Checking for updates…";
    case "up_to_date":
      return "Moosewave is up to date";
    case "not_configured":
      return "No update channel in this build";
    case "available":
      return `Version ${latestVersion ?? "new"} is available`;
    case "downloading":
      return `Downloading version ${latestVersion ?? "update"}`;
    case "installing":
      return `Installing version ${latestVersion ?? "update"}`;
    case "ready_to_restart":
      return `Version ${latestVersion ?? "new"} is ready to use`;
    case "error":
      return "Desktop update needs attention";
    default:
      return "Desktop update status";
  }
}

function phaseDetail(phase: DesktopUpdatePhase): string {
  switch (phase) {
    case "not_configured":
      return "This development or custom build was compiled without a signed update channel.";
    case "available":
      return "You can keep working while the signed package downloads.";
    case "downloading":
      return "Moosewave remains usable. Keep the app open until installation finishes.";
    case "installing":
      return "The downloaded artifact is being verified and staged.";
    case "ready_to_restart":
      return "Your current session keeps running until you explicitly choose to restart.";
    case "error":
      return "Your current version remains installed. Retry when your connection is stable.";
    default:
      return "Scheduled checks run shortly after launch and every six hours.";
  }
}

function severityLabel(severity: string): string {
  switch (severity) {
    case "critical":
      return "Critical";
    case "important":
      return "Important";
    case "informational":
      return "Optional";
    default:
      return "Recommended";
  }
}

function severityClass(severity: string): string {
  if (severity === "critical") return "danger";
  if (severity === "important") return "warning";
  if (severity === "informational") return "neutral";
  return "accent";
}

function formatDateTime(value: number | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "an unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function progressLabel(
  downloaded: number,
  total: number | null,
  percent: number | null,
): string {
  if (total === null || percent === null) {
    return downloaded > 0
      ? `${formatBytes(downloaded)} downloaded`
      : "Preparing…";
  }
  return `${percent}% · ${formatBytes(downloaded)} of ${formatBytes(total)}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`;
}
