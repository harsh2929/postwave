export type AffiliateWorkspace =
  | "release"
  | "attribution"
  | "commercial"
  | "settlement";

export type QualificationState = "blocked" | "contained";

export interface AffiliateWorkspaceDefinition {
  description: string;
  id: AffiliateWorkspace;
  label: string;
}

export interface AffiliateQualificationItem {
  detail: string;
  id: string;
  label: string;
  state: QualificationState;
}

export const AFFILIATE_WORKSPACES: ReadonlyArray<AffiliateWorkspaceDefinition> =
  [
    {
      id: "release",
      label: "Release status",
      description: "Current boundary",
    },
    {
      id: "attribution",
      label: "Attribution",
      description: "Identity + consent",
    },
    {
      id: "commercial",
      label: "Commercial",
      description: "Terms + policy",
    },
    {
      id: "settlement",
      label: "Settlement",
      description: "Approval + payout",
    },
  ];

export const AFFILIATE_QUALIFICATION_ITEMS: ReadonlyArray<AffiliateQualificationItem> =
  [
    {
      id: "runtime",
      label: "Runtime composition",
      state: "contained",
      detail:
        "Public enrollment, workspace administration, new attribution accrual, and payout controls are not exposed.",
    },
    {
      id: "authority",
      label: "Operator authority",
      state: "blocked",
      detail:
        "A platform-global partner ledger needs dedicated operator identity; a workspace admin role is not sufficient.",
    },
    {
      id: "terms",
      label: "Terms evidence",
      state: "blocked",
      detail:
        "Acceptance needs an immutable terms version, timestamp, jurisdiction, actor, and evidence receipt.",
    },
    {
      id: "privacy",
      label: "Attribution privacy",
      state: "blocked",
      detail:
        "Cookie scope, consent, proxy trust, retention, erasure, and raw network metadata need a reviewed policy.",
    },
    {
      id: "ledger",
      label: "Commission ledger",
      state: "blocked",
      detail:
        "Every accrual needs stored policy, rate, currency, billing event, recurring period, and reversal lineage.",
    },
    {
      id: "settlement",
      label: "Settlement control",
      state: "blocked",
      detail:
        "Payouts need approved-only eligibility, immutable previews, dual control, idempotency, and reconciliation.",
    },
  ];

export const AFFILIATE_RELEASE_EVIDENCE = [
  "Platform-operator authorization matrix",
  "Versioned program terms and acceptance receipts",
  "Regional privacy, cookie, retention, and erasure review",
  "Immutable commission-policy and currency snapshots",
  "Approved-only payout preview-to-commit contract",
  "Provider sandbox, failure, retry, and reconciliation evidence",
] as const;
