"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// Root error boundary — the last line of defence when even the root layout
// throws. It replaces the whole document, so it renders its own <html>/<body>
// and pulls in globals.css for the fail-loud styling. Still: unknown is not
// green.

import { useEffect } from "react";

import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("ops console: root render failed", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="fail" role="alert">
          <h1 className="fail__title">OPS CONSOLE DOWN</h1>
          <p className="fail__msg">
            The console itself failed to render. Nothing on this screen can be
            trusted right now — assume something is on fire and check the
            underlying systems directly.
          </p>
          {error.digest ? <p className="fail__note">ref: {error.digest}</p> : null}
          <p style={{ marginTop: "1.25rem" }}>
            <button type="button" className="btn" onClick={() => reset()}>
              Reload the console
            </button>
          </p>
        </main>
      </body>
    </html>
  );
}
