/**
 * CustomerAgentPanel — release truth for the source-held draft foundation.
 *
 * The draft endpoint is a non-idempotent create and is held at the source.
 * This panel therefore does not load requester records, offer a conversation
 * picker, or manufacture a draft. It presents only the static catalog
 * guardrail and the exact hold code until a replay-safe create contract exists.
 */

import type { ReactElement } from "react";

import type { ServiceSuiteCatalog } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { catalogGuardrailText } from "./agent-helpers";

export function CustomerAgentPanel({
  catalog,
  tenantId,
  accessAllowed,
  online = true,
}: {
  catalog: ServiceSuiteCatalog | null;
  tenantId: string | null;
  accessAllowed: boolean;
  online?: boolean;
}): ReactElement {
  const canAdmin = useCanAdmin();

  if (!accessAllowed || !tenantId || !canAdmin) {
    return (
      <div
        className="card helpdesk-locked-panel"
        data-helpdesk-state="access-denied"
      >
        <div className="helpdesk-state-icon" aria-hidden="true">
          ⌁
        </div>
        <h2>Customer Agent records are admin-only</h2>
        <p>No conversation, ticket, requester, or Agent run was requested.</p>
      </div>
    );
  }

  return (
    <div className="helpdesk-agent-layout">
      <div
        className="card helpdesk-agent-composer"
        data-helpdesk-state="agent-create-held"
      >
        <div>
          <div className="helpdesk-section-kicker">Source-held foundation</div>
          <h2>Customer Agent draft</h2>
          <p className="muted">
            The declared foundation is deterministic templating only. No
            provider, customer mutation, delivery, conversation grounding, or
            Agent run is executed from this panel.
          </p>
        </div>

        <div className="helpdesk-release-hold" role="status">
          <strong>Draft creation unavailable</strong>
          <span>
            The non-idempotent create is held before request-body processing or
            persistence (`customer_agent_draft_write_held`).
          </span>
        </div>

        <dl className="helpdesk-agent-truth-grid">
          <div>
            <dt>Execution mode</dt>
            <dd>Deterministic template declaration</dd>
          </div>
          <div>
            <dt>Provider executed</dt>
            <dd>No</dd>
          </div>
          <div>
            <dt>Customer mutation</dt>
            <dd>Unavailable</dd>
          </div>
          <div>
            <dt>Recorded run</dt>
            <dd>None created by this view</dd>
          </div>
        </dl>

        <div className="muted helpdesk-agent-guardrail-copy">
          {catalogGuardrailText(catalog) ||
            "Static guardrail verification is unavailable. Treat all Agent capability as held."}
        </div>

        {!online ? (
          <div className="helpdesk-partial-notice" role="status">
            Helpdesk is offline. The source hold remains in force; nothing is
            queued for later execution.
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled
          aria-describedby="helpdesk-agent-create-hold"
        >
          Generate draft — unavailable
        </button>
        <span id="helpdesk-agent-create-hold" className="muted">
          No request will be sent until a replay-safe create contract is
          available.
        </span>
      </div>
    </div>
  );
}
