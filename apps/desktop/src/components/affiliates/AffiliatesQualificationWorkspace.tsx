import { type ReactElement, useState } from "react";

import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import {
  AFFILIATE_ADMIN_INSPECTION_UNAVAILABLE_REASON,
  AFFILIATE_ATTRIBUTION_ACCRUAL_UNAVAILABLE_REASON,
  AFFILIATE_PAYOUT_OPERATIONS_UNAVAILABLE_REASON,
  AFFILIATE_PUBLIC_OFFER_UNAVAILABLE_REASON,
} from "../../lib/affiliate-operational-availability";
import {
  AFFILIATE_QUALIFICATION_ITEMS,
  AFFILIATE_RELEASE_EVIDENCE,
  AFFILIATE_WORKSPACES,
  type AffiliateWorkspace,
  type QualificationState,
} from "./affiliate-qualification";

function ShieldIcon(): ReactElement {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6Z" />
      <path d="m9.5 12 1.7 1.7 3.7-4" />
    </svg>
  );
}

function PartnerIcon(): ReactElement {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M2.8 20c.5-3.3 2.5-5 5.2-5s4.8 1.7 5.2 5" />
      <path d="M14.5 15.4c2.8-.6 5.7.9 6.4 3.6" />
    </svg>
  );
}

function LockIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function StateMark({ state }: { state: QualificationState }): ReactElement {
  return (
    <span className={`aff-state-mark is-${state}`} aria-hidden="true">
      {state === "contained" ? <CheckIcon /> : <LockIcon />}
    </span>
  );
}

function PartnerFlow(): ReactElement {
  const stages = [
    ["01", "Apply", "Offer closed"],
    ["02", "Attribute", "Accrual closed"],
    ["03", "Approve", "Policy pending"],
    ["04", "Settle", "Payout closed"],
  ] as const;

  return (
    <aside className="aff-flow" aria-label="Contained affiliate lifecycle">
      <div className="aff-flow-head">
        <span>Partner lifecycle</span>
        <span className="aff-flow-state">
          <span aria-hidden="true" />
          Contained
        </span>
      </div>
      <ol className="aff-flow-track">
        {stages.map(([index, label, detail]) => (
          <li key={index}>
            <span className="aff-flow-node">
              <span>{index}</span>
              <LockIcon />
            </span>
            <span className="aff-flow-copy">
              <strong>{label}</strong>
              <small>{detail}</small>
            </span>
          </li>
        ))}
      </ol>
      <div className="aff-flow-signal" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p>
        No enrollment, tracking, commission, partner-record, or payout request
        is made from this workspace.
      </p>
    </aside>
  );
}

function ReleasePanel(): ReactElement {
  return (
    <div className="aff-release-layout">
      <section
        className="aff-qualification-panel"
        aria-labelledby="affiliate-qualification-title"
      >
        <header className="aff-section-head">
          <div>
            <p>Qualification matrix</p>
            <h2 id="affiliate-qualification-title">
              One safe boundary. Six explicit release gates.
            </h2>
          </div>
          <span className="aff-boundary-badge">Operations held</span>
        </header>
        <div className="aff-qualification-grid">
          {AFFILIATE_QUALIFICATION_ITEMS.map((item) => (
            <article key={item.id} className={`is-${item.state}`}>
              <StateMark state={item.state} />
              <div>
                <span className="aff-item-state">
                  {item.state === "contained" ? "Contained" : "Release blocker"}
                </span>
                <h3>{item.label}</h3>
                <p>{item.detail}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <aside
        className="aff-evidence-panel"
        aria-labelledby="aff-evidence-title"
      >
        <p className="aff-panel-kicker">Required evidence</p>
        <h2 id="aff-evidence-title">What must exist before activation.</h2>
        <ol>
          {AFFILIATE_RELEASE_EVIDENCE.map((item, index) => (
            <li key={item}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {item}
            </li>
          ))}
        </ol>
        <p className="aff-evidence-foot">
          Release is atomic: passing one row does not unlock a partial money
          path.
        </p>
      </aside>
    </div>
  );
}

function AttributionPanel(): ReactElement {
  const stages = [
    {
      index: "01",
      title: "Partner identity",
      detail:
        "Approve an accountable legal party under a dedicated platform-operator boundary.",
      evidence: "Identity, jurisdiction, status history",
    },
    {
      index: "02",
      title: "Visitor consent",
      detail:
        "Disclose attribution before setting a narrowly scoped, purpose-bound identifier.",
      evidence: "Consent receipt, region, policy version",
    },
    {
      index: "03",
      title: "Billing match",
      detail:
        "Bind a verified click to one eligible billing event without trusting a replayable browser token.",
      evidence: "Click lineage, event id, trusted source",
    },
    {
      index: "04",
      title: "Ledger entry",
      detail:
        "Snapshot the exact policy, rate, currency, period, and reversal relationship.",
      evidence: "Immutable accrual receipt",
    },
  ] as const;

  return (
    <section
      className="aff-deep-panel"
      aria-labelledby="affiliate-attribution-title"
    >
      <header className="aff-deep-head">
        <div>
          <p>Attribution chain</p>
          <h2 id="affiliate-attribution-title">
            Credit only what can be explained later.
          </h2>
        </div>
        <span className="aff-boundary-badge">Accrual closed</span>
      </header>
      <p className="aff-deep-intro">
        A referral cookie is not financial evidence. The production path must
        preserve who, why, when, where, and under which commercial policy every
        commission was created.
      </p>
      <ol className="aff-attribution-chain">
        {stages.map((stage) => (
          <li key={stage.index}>
            <span className="aff-chain-index">{stage.index}</span>
            <span className="aff-chain-line" aria-hidden="true" />
            <div>
              <span className="aff-chain-status">
                <LockIcon />
                Evidence required
              </span>
              <h3>{stage.title}</h3>
              <p>{stage.detail}</p>
              <small>{stage.evidence}</small>
            </div>
          </li>
        ))}
      </ol>
      <div className="aff-reason-note">
        <ShieldIcon />
        <span>
          <strong>Why this is closed.</strong>{" "}
          {AFFILIATE_ATTRIBUTION_ACCRUAL_UNAVAILABLE_REASON}
        </span>
      </div>
    </section>
  );
}

function CommercialPanel(): ReactElement {
  const cards = [
    {
      label: "Program terms",
      title: "A contract, not a checkbox.",
      detail:
        "Store terms version, acceptance time, actor, jurisdiction, and the exact offer the partner accepted.",
      proof: "Acceptance receipt + immutable document",
    },
    {
      label: "Commission policy",
      title: "Rates need effective dates.",
      detail:
        "Version rates by product, billing period, currency, caps, exclusions, and grandfathering behavior.",
      proof: "Policy snapshot on every accrual",
    },
    {
      label: "Tax + geography",
      title: "Jurisdiction changes the workflow.",
      detail:
        "Collect the right tax evidence, expiry, withholding treatment, sanctions status, and payout eligibility.",
      proof: "Country-aware compliance decision",
    },
    {
      label: "Privacy + retention",
      title: "Collect less, keep it deliberately.",
      detail:
        "Document consent, purpose, retention, erasure, DSAR handling, sub-processors, and raw network-data access.",
      proof: "Approved DPIA and retention schedule",
    },
  ] as const;

  return (
    <section
      className="aff-deep-panel"
      aria-labelledby="affiliate-commercial-title"
    >
      <header className="aff-deep-head">
        <div>
          <p>Commercial foundation</p>
          <h2 id="affiliate-commercial-title">
            Make the promise precise before publishing it.
          </h2>
        </div>
        <span className="aff-boundary-badge">Offer closed</span>
      </header>
      <div className="aff-commercial-grid">
        {cards.map((card, index) => (
          <article key={card.label}>
            <span className="aff-commercial-index">
              {String(index + 1).padStart(2, "0")}
            </span>
            <p>{card.label}</p>
            <h3>{card.title}</h3>
            <span>{card.detail}</span>
            <small>
              <CheckIcon />
              {card.proof}
            </small>
          </article>
        ))}
      </div>
      <div className="aff-reason-note">
        <ShieldIcon />
        <span>
          <strong>Why applications are closed.</strong>{" "}
          {AFFILIATE_PUBLIC_OFFER_UNAVAILABLE_REASON}
        </span>
      </div>
    </section>
  );
}

function SettlementPanel(): ReactElement {
  const controls = [
    [
      "Eligible set",
      "Approved conversions only; disputes and pending review excluded.",
    ],
    [
      "Immutable preview",
      "Exact conversion ids, amount, currency, rail, and policy hash.",
    ],
    [
      "Dual authorization",
      "Independent preparer and approver with explicit expected totals.",
    ],
    [
      "Provider commit",
      "Request idempotency survives retries, crashes, and ambiguous timeouts.",
    ],
    [
      "Reconciliation",
      "Provider receipt, local state, exception queue, and reversal lineage converge.",
    ],
  ] as const;

  return (
    <section
      className="aff-deep-panel"
      aria-labelledby="affiliate-settlement-title"
    >
      <header className="aff-deep-head">
        <div>
          <p>Settlement control</p>
          <h2 id="affiliate-settlement-title">
            Preview exactly what will move. Then prove what moved.
          </h2>
        </div>
        <span className="aff-boundary-badge">Payouts closed</span>
      </header>
      <div className="aff-settlement-layout">
        <ol className="aff-settlement-steps">
          {controls.map(([label, detail], index) => (
            <li key={label}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{label}</h3>
                <p>{detail}</p>
              </div>
              <LockIcon />
            </li>
          ))}
        </ol>
        <aside className="aff-settlement-receipt">
          <div className="aff-receipt-head">
            <span>Settlement preview</span>
            <span>Not generated</span>
          </div>
          <dl>
            <div>
              <dt>Eligible conversions</dt>
              <dd>Not requested</dd>
            </div>
            <div>
              <dt>Expected amount</dt>
              <dd>Not calculated</dd>
            </div>
            <div>
              <dt>Currency + rail</dt>
              <dd>Not selected</dd>
            </div>
            <div>
              <dt>Authorization</dt>
              <dd>Not available</dd>
            </div>
          </dl>
          <p>
            This is an explanatory boundary, not a disabled payout form. No
            partner or financial data has been loaded.
          </p>
        </aside>
      </div>
      <div className="aff-reason-note">
        <ShieldIcon />
        <span>
          <strong>Why settlement is closed.</strong>{" "}
          {AFFILIATE_PAYOUT_OPERATIONS_UNAVAILABLE_REASON}
        </span>
      </div>
    </section>
  );
}

function WorkspacePanel({
  workspace,
}: {
  workspace: AffiliateWorkspace;
}): ReactElement {
  switch (workspace) {
    case "attribution":
      return <AttributionPanel />;
    case "commercial":
      return <CommercialPanel />;
    case "settlement":
      return <SettlementPanel />;
    case "release":
    default:
      return <ReleasePanel />;
  }
}

export function AffiliatesQualificationWorkspace(): ReactElement {
  const [workspace, setWorkspace] = useState<AffiliateWorkspace>("release");
  const tabs = useTabsInteraction<AffiliateWorkspace>({
    value: workspace,
    items: AFFILIATE_WORKSPACES.map((item) => ({ value: item.id })),
    onChange: setWorkspace,
  });

  return (
    <main className="aff-page">
      <section className="aff-hero" aria-labelledby="affiliates-page-title">
        <div className="aff-hero-copy">
          <div className="aff-eyebrow">
            <span>
              <PartnerIcon />
            </span>
            Partner operations
          </div>
          <div className="aff-status-row" role="status">
            <span className="aff-status-chip">
              <span aria-hidden="true" />
              Release held
            </span>
            <span className="aff-status-secondary">
              <ShieldIcon />
              Fail-closed by design
            </span>
          </div>
          <h1 id="affiliates-page-title">
            Qualify the partner engine before money moves.
          </h1>
          <p>
            This workspace exposes the exact release boundary for partner
            enrollment, attribution, commissions, and settlement. It does not
            load platform-global affiliate records or imply that a commercial
            program is live.
          </p>
          <div className="aff-hero-facts" aria-label="Current containment">
            <span>
              <strong>Public offer</strong>
              Closed
            </span>
            <span>
              <strong>New accrual</strong>
              Closed
            </span>
            <span>
              <strong>Payouts</strong>
              Closed
            </span>
          </div>
          <p className="aff-authority-note">
            <ShieldIcon />
            <span>{AFFILIATE_ADMIN_INSPECTION_UNAVAILABLE_REASON}</span>
          </p>
        </div>
        <PartnerFlow />
      </section>

      <div
        ref={tabs.listRef}
        className="aff-workspace-tabs"
        {...tabs.listProps}
        aria-label="Affiliate qualification workspaces"
      >
        {AFFILIATE_WORKSPACES.map((item, index) => (
          <button key={item.id} type="button" {...tabs.getTabProps(item.id)}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </div>

      {AFFILIATE_WORKSPACES.map((item) => (
        <div
          key={item.id}
          {...tabs.getPanelProps(item.id)}
          tabIndex={item.id === workspace ? 0 : -1}
          className="aff-workspace-panel"
        >
          <WorkspacePanel workspace={item.id} />
        </div>
      ))}
    </main>
  );
}
