// SPDX-License-Identifier: AGPL-3.0-only
//
// Shown while a segment's server fetch is in flight (every ops page is
// force-dynamic). A neutral, board-flavoured skeleton so navigation never
// flashes blank — and, per the console's ethos, an empty frame reads clearly
// as "loading", never as a confident all-clear.

import type { CSSProperties } from "react";

const line = (w: string, h = "0.85rem"): CSSProperties => ({ width: w, height: h });

export default function Loading() {
  return (
    <main id="main-content" tabIndex={-1} className="page" role="status" aria-label="Loading">
      <div className="page__head" aria-hidden="true">
        <span className="skel" style={{ ...line("11rem", "1.4rem"), display: "block" }} />
      </div>

      <div className="statbar" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="stat">
            <span className="skel" style={{ ...line("45%", "1.6rem"), display: "block", marginBottom: "0.5rem" }} />
            <span className="skel skel--line" style={line("70%")} />
          </div>
        ))}
      </div>

      <div aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skel skel--lane" />
        ))}
      </div>
    </main>
  );
}
