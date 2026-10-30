import { type ReactElement, useEffect, useRef, useState } from "react";

import { requestDesktopRouteNavigation } from "../../lib/desktop-router";
import "../../styles-postwave-ai-agent.css";

const MCP_RELEASE_HOLD_CODE = "mcp_distribution_release_held";

/** Moosewave AI context only; MCP owns setup, keys, catalog and observability. */
export function McpAgentSummary(): ReactElement {
  const mountedRef = useRef(true);
  const navigationRef = useRef(false);
  const [openingStatus, setOpeningStatus] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const openMcpStatus = async (): Promise<void> => {
    if (navigationRef.current) return;
    navigationRef.current = true;
    setOpeningStatus(true);
    try {
      await requestDesktopRouteNavigation({ section: "mcp", tab: "setup" });
    } finally {
      navigationRef.current = false;
      if (mountedRef.current) setOpeningStatus(false);
    }
  };

  return (
    <section className="card ai-agent-summary" aria-labelledby="ai-agent-title">
      <header className="ai-agent-header">
        <div className="ai-agent-glyph" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <span className="ai-agent-kicker">Model Context Protocol</span>
          <div id="ai-agent-title" className="section-title">
            MCP distribution is release-held
          </div>
          <p className="muted ai-agent-intro">
            The checked-in catalogue is a mutable source candidate, not an
            installed client, hosted connector, or working-key setup.
          </p>
        </div>
      </header>

      <ol className="ai-agent-boundaries" aria-label="Agent control boundary">
        <li>
          <span aria-hidden="true">01</span>
          <div>
            <strong>Source candidate</strong>
            <small>Definitions may differ from immutable package artifacts.</small>
          </div>
        </li>
        <li>
          <span aria-hidden="true">02</span>
          <div>
            <strong>No runnable setup</strong>
            <small>
              Client installation and credential transfer are disabled.
            </small>
          </div>
        </li>
        <li>
          <span aria-hidden="true">03</span>
          <div>
            <strong>Qualification required</strong>
            <small>
              A new version, digest, catalogue probe, and runtime review must
              lift the hold.
            </small>
          </div>
        </li>
      </ol>

      <div className="ai-agent-boundary-note" role="note">
        <strong>{MCP_RELEASE_HOLD_CODE}</strong>
        <span>
          Catalogue exploration is unsupported private-source evaluation only;
          no supported runnable setup is published. It makes no promise of
          complete scoping, quotas, approvals, audit durability, or runtime
          availability.
        </span>
      </div>

      <div className="ai-agent-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void openMcpStatus()}
          disabled={openingStatus}
        >
          {openingStatus ? "Opening status…" : "Review MCP release status"}
        </button>
      </div>
    </section>
  );
}
