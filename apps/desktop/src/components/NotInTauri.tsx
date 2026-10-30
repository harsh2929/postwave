/**
 * Shown when the bundled frontend is opened directly in a regular browser
 * (i.e. not via the Tauri shell). One button: open the hosted web app.
 */

import type { ReactElement } from "react";

import { tauriApi } from "../lib/tauri";
import { getDashboardUrl } from "../lib/dashboard-url";

export function NotInTauri(): ReactElement {
  const openWebApp = () => {
    void tauriApi.openUrl(getDashboardUrl());
  };

  return (
    <div className="pw-screen" role="alert">
      <div className="pw-wordmark">postwave</div>
      <h1>This app should be run inside Moosewave Desktop</h1>
      <p>You can also access Moosewave directly from your browser.</p>
      <div className="pw-actions">
        <button type="button" className="btn btn-primary" onClick={openWebApp}>
          Open Moosewave in browser
        </button>
      </div>
    </div>
  );
}
