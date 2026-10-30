import { type ReactElement, useId } from "react";

import { AgentConnectCard } from "../ai/AgentConnectCard";
import { Notice } from "../Notice";

/**
 * Route-owned MCP setup boundary.
 *
 * The advertised @postwave/mcp-server transport currently projects the broad
 * REST catalogue, not the separate native read-only candidate/control path.
 * Until
 * transport-independent scope and approval enforcement is qualified, this
 * surface intentionally renders placeholder configuration only and exposes no
 * key mint/list/revoke callback. Canonical API-key lifecycle remains in
 * Settings.
 */
export function McpConnectionSetup({
  identityScope,
}: {
  identityScope: string;
}): ReactElement {
  const headingId = useId();
  return (
    <div className="mcp-connection-workspace">
      <section className="mcp-governance-gate" aria-labelledby={headingId}>
        <div className="mcp-governance-gate-copy">
          <span className="mcp-kicker">Provisioning boundary</span>
          <h2 id={headingId}>Review the transport before granting access</h2>
          <p>
            The client package and the native read-only candidate/control path
            do not share one qualified authorization, lifecycle, or input-schema
            contract. This setup therefore stays placeholder-only and cannot
            mint or inject a working credential.
          </p>
        </div>
        <div className="mcp-governance-signals" aria-label="Setup safeguards">
          <span className="badge success">Secrets excluded</span>
          <span className="badge warning">Write access held</span>
          <span className="badge neutral">Admin review required</span>
        </div>
      </section>

      <Notice tone="warning" title="Live MCP provisioning is release-held">
        Catalogue presence is discovery evidence, not proof that a tool is
        approval-gated or authorized for this workspace. Use Settings for
        existing API-key lifecycle operations; do not provision a production MCP
        client until an owned deployment has independently verified transport
        lifecycle, per-tool scopes, input schemas, and mutation approvals.
      </Notice>

      <AgentConnectCard
        key={identityScope}
        apiKey=""
        transfersEnabled={false}
      />
    </div>
  );
}
