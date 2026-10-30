import type { ReactElement } from "react";

import {
  isDesktopUpdateAttentionDue,
  useDesktopUpdateState,
} from "../lib/desktop-update-service";

import "../styles-desktop-update.css";

/** Lazy top-bar projection; the full updater state machine stays off the
 * critical renderer bundle while the pre-boot initializer still listens. */
export function DesktopUpdateBadge(): ReactElement | null {
  const update = useDesktopUpdateState();
  if (!isDesktopUpdateAttentionDue(update)) return null;
  const message =
    update.phase === "ready_to_restart"
      ? `Moosewave ${update.latestVersion ?? "update"} is installed; restart to finish.`
      : `Moosewave ${update.latestVersion ?? "update"} is available.`;
  return (
    <>
      <span
        className="topbar-update-dot"
        data-phase={update.phase}
        data-severity={update.severity}
        aria-hidden="true"
      />
      <span id="desktop-update-badge-status" className="sr-only" role="status">
        {message}
      </span>
    </>
  );
}
