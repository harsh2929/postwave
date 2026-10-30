"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// Segment-level error boundary. When a view throws during render, React would
// otherwise unmount it — leaving a blank frame that reads as "nothing here",
// i.e. a false all-clear. The console's one rule is that unknown is never
// green, so a crash fails LOUD and offers a retry.

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The operator sees the loud UI; the detail goes to the server logs.
    console.error("ops console: view crashed", error);
  }, [error]);

  return (
    <main id="main-content" tabIndex={-1} className="fail" role="alert">
      <h1 className="fail__title">THIS VIEW CRASHED</h1>
      <p className="fail__msg">
        It failed before it could render, so its data is unknown — assume
        something is on fire until it loads.
      </p>
      {error.digest ? <p className="fail__note">ref: {error.digest}</p> : null}
      <p style={{ marginTop: "1.25rem" }}>
        <button type="button" className="btn" onClick={() => reset()}>
          Retry this view
        </button>
      </p>
    </main>
  );
}
