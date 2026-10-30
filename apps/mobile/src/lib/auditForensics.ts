/**
 * lib/auditForensics.ts — parsing + access policy for the per-event forensic
 * endpoints (request chain, anomaly explanation, inclusion proof, session
 * replay, PII unmask, retention override).
 *
 * Every wire shape below was read off the Go handlers, not the OpenAPI doc:
 *
 *   GET  /audit/chain/{requestId}        handlers/audit_chain.go
 *        → { requestId, rows: [auditChainRow…], truncated }
 *   GET  /audit/{id}/anomaly-score       handlers/audit_anomaly.go
 *        → AnomalyScoreResponse — `available:false` is an ANSWER, not a 404
 *   GET  /audit/{id}/inclusion-proof     auditsink/proof.go
 *        → InclusionProof; 425 no_checkpoint = "not rooted yet, retry"
 *   GET  /audit/{id}/session-replay      audit/session_link.go
 *        → ReplayURLResponse | {available:false, reason}
 *   POST /audit/{id}/unmask              handlers/audit_extras.go
 *        → { id, metadata, unmaskedFields, unmaskedAt }
 *   PATCH /audit/{id}/retention-override handlers/audit_extras.go
 *        body {retention_override_days?, legal_hold?}, days 1..3650
 *
 * ── WHO MAY DO WHAT, and why the answer is not "the manifest row" ──────────
 * The generated routeauth manifest and the MOUNT-SITE gates both run, and the
 * BINDING gate is whichever is stricter (see server/audit_operations.go):
 *
 *   chain / anomaly-score / session-replay — mount `gates.raw` =
 *     RequireAllScopes(audit:read, audit:read_pii). For a session the scope
 *     set is what GET /audit/my-scopes reports, so `hasAuditPiiScope` is the
 *     honest client-side verdict.
 *   inclusion-proof — mounted `RequireScope(ScopeAdmin)` (line 83), which for
 *     a session demands owner|admin. The manifest row says viewer, but the
 *     mount is the stricter, binding gate — so the affordance is admin-only.
 *   unmask — routeauth session floor is ADMIN (reviewed row), and the mount
 *     demands read+read_pii+execute_actions for API keys.
 *   retention-override — mounted `RequireScope(ScopeAdmin)`; admin either way.
 *
 * Import-free of react-native; asserted under node vitest.
 */

/** Structural mirror of hooks/useAudit's AuditScopes, so this lib stays pure. */
export interface AuditScopeSet {
  isAdmin: boolean;
  auditScopes: string[];
}

export type AuditAuthMode = "session" | "api_key" | null | undefined;

export interface AuditWriteAccess {
  allowed: boolean;
  /** False while the scope answer is still in flight. */
  known: boolean;
  /** Why not, in the reader's terms — a permission rule, never a failure. */
  notice: string | null;
}

function hasScope(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope) || scopes.includes("admin");
}

/**
 * May this actor reveal an event's sealed metadata? Session floor is admin
 * (routeauth, reviewed); an API key needs the full triple or admin.
 */
export function auditUnmaskAccess(input: {
  scopes: AuditScopeSet | null | undefined;
  mode: AuditAuthMode;
  online: boolean;
}): AuditWriteAccess {
  const scopes = input.scopes;
  if (!scopes) return { allowed: false, known: false, notice: null };
  if (input.mode === "api_key") {
    const ok =
      scopes.isAdmin ||
      (hasScope(scopes.auditScopes, "audit:read") &&
        hasScope(scopes.auditScopes, "audit:read_pii") &&
        hasScope(scopes.auditScopes, "audit:execute_actions"));
    if (!ok) {
      return {
        allowed: false,
        known: true,
        notice:
          "Revealing sealed metadata needs an API key holding audit:read, audit:read_pii and audit:execute_actions (or admin).",
      };
    }
  } else if (!scopes.isAdmin) {
    return {
      allowed: false,
      known: true,
      notice:
        "Revealing sealed metadata is limited to workspace owners and admins. The reveal itself is recorded in the audit trail.",
    };
  }
  if (!input.online) {
    return {
      allowed: false,
      known: true,
      notice:
        "You're offline. A reveal is recorded as PII access the moment it runs, so it is never queued for later.",
    };
  }
  return { allowed: true, known: true, notice: null };
}

/** Per-event retention override / legal hold — admin on every path. */
export function retentionOverrideAccess(input: {
  scopes: AuditScopeSet | null | undefined;
  mode: AuditAuthMode;
  online: boolean;
}): AuditWriteAccess {
  const scopes = input.scopes;
  if (!scopes) return { allowed: false, known: false, notice: null };
  if (!scopes.isAdmin) {
    return {
      allowed: false,
      known: true,
      notice:
        input.mode === "api_key"
          ? "Retention holds need an API key with the admin scope."
          : "Placing or releasing a retention hold is limited to workspace owners and admins.",
    };
  }
  if (!input.online) {
    return {
      allowed: false,
      known: true,
      notice:
        "You're offline. A hold that appears placed but was only queued would be false evidence-preservation, so this write is never queued.",
    };
  }
  return { allowed: true, known: true, notice: null };
}

/**
 * Inclusion proof — the MOUNT gate is RequireScope(ScopeAdmin), stricter than
 * the manifest's viewer row, so only owner/admin may be offered the control.
 */
export function inclusionProofAccess(
  scopes: AuditScopeSet | null | undefined,
): boolean {
  return Boolean(scopes?.isAdmin);
}

// ── request chain ──────────────────────────────────────────────────────────

export interface AuditChainRow {
  id: number;
  action: string;
  resourceType: string;
  resourceId: string;
  actorType: string;
  actorLabel: string;
  ip: string;
  userAgent: string;
  metadata: Record<string, unknown>;
  at: string;
}

export interface AuditChainResult {
  requestId: string;
  /** ASCENDING — a chain is a narrative, not a feed. */
  rows: AuditChainRow[];
  /** Row 501 existed; the server withheld the rest and said so. */
  truncated: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseAuditChain(body: unknown): AuditChainResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawRows = Array.isArray(b.rows) ? b.rows : [];
  const rows: AuditChainRow[] = [];
  for (const raw of rawRows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = typeof r.id === "number" ? r.id : Number(r.id);
    if (!Number.isFinite(id)) continue;
    rows.push({
      id,
      action: str(r.action),
      resourceType: str(r.resourceType),
      resourceId: str(r.resourceId),
      actorType: str(r.actorType),
      actorLabel: str(r.actorLabel),
      ip: str(r.ip),
      userAgent: str(r.userAgent),
      metadata:
        r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
          ? (r.metadata as Record<string, unknown>)
          : {},
      at: str(r.at),
    });
  }
  return {
    requestId: str(b.requestId),
    rows,
    truncated: b.truncated === true,
  };
}

/**
 * The correlation id an audit row carries, if any. The server stamps it at
 * `metadata.context.correlation_id` (audit_chain.go) — the same id the API's
 * error envelopes and log lines print, so it is what an on-call engineer has
 * in hand.
 */
export function correlationIdFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const context = metadata?.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  const id = (context as Record<string, unknown>).correlation_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

// ── anomaly explanation ────────────────────────────────────────────────────

export interface AnomalyReason {
  type: string;
  confidence: number | null;
  reason: string;
  mitre: string[];
}

export interface AnomalyExplanation {
  available: boolean;
  score: number;
  bucket: string;
  reasons: AnomalyReason[];
  /** "typically active 9–17 UTC, 41 actions/day" style facts, pre-sentenced. */
  baseline: string[] | null;
}

export function parseAnomalyExplanation(body: unknown): AnomalyExplanation {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawReasons = Array.isArray(b.reasons) ? b.reasons : [];
  const reasons: AnomalyReason[] = rawReasons.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      type: str(r.type),
      confidence: typeof r.confidence === "number" ? r.confidence : null,
      reason: str(r.reason),
      mitre: Array.isArray(r.mitre) ? r.mitre.filter((m): m is string => typeof m === "string") : [],
    };
  });
  const baselineRaw = b.baseline as Record<string, unknown> | null | undefined;
  let baseline: string[] | null = null;
  if (baselineRaw && typeof baselineRaw === "object") {
    const facts: string[] = [];
    const mean = baselineRaw.meanActionsPerDay;
    if (typeof mean === "number" && mean > 0) {
      facts.push(`typically ${Math.round(mean)} actions/day`);
    }
    const ips = baselineRaw.typicalIps;
    if (Array.isArray(ips) && ips.length > 0) {
      facts.push(`usual IPs: ${ips.slice(0, 3).join(", ")}`);
    }
    if (facts.length > 0) baseline = facts;
  }
  return {
    available: b.available === true,
    score: typeof b.score === "number" ? b.score : 0,
    bucket: str(b.bucket),
    reasons,
    baseline,
  };
}

// ── inclusion proof ────────────────────────────────────────────────────────

export type InclusionProofAnswer =
  | {
      kind: "proof";
      leafId: number;
      leafHash: string;
      pathLength: number;
      treeSize: number;
      rootHash: string;
      rootKid: string;
      anchoredAt: string;
      signed: boolean;
    }
  | {
      /** The Merkle worker has not rooted this row yet — retry in a minute. */
      kind: "pending";
    };

export function parseInclusionProof(body: unknown): InclusionProofAnswer {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    kind: "proof",
    leafId: typeof b.leaf_id === "number" ? b.leaf_id : 0,
    leafHash: str(b.leaf_hash),
    pathLength: Array.isArray(b.audit_path) ? b.audit_path.length : 0,
    treeSize: typeof b.tree_size === "number" ? b.tree_size : 0,
    rootHash: str(b.root_hash),
    rootKid: str(b.root_kid),
    anchoredAt: str(b.anchored_at),
    signed: Boolean(str(b.root_signature)),
  };
}

// ── session replay ─────────────────────────────────────────────────────────

export interface SessionReplayAnswer {
  available: boolean;
  replayUrl: string;
  provider: string;
  /** Why not, when the server said so (e.g. no_replay_for_session). */
  reason: string;
}

export function parseSessionReplay(body: unknown): SessionReplayAnswer {
  const b = (body ?? {}) as Record<string, unknown>;
  const available = b.available === true;
  // https only. This value reaches WebBrowser.openBrowserAsync, whose
  // Android implementation builds an ACTION_VIEW intent from the raw string
  // with no scheme check (iOS refuses non-http(s) itself), so a hostile or
  // mis-set server could launch an arbitrary scheme from the app. Every
  // sibling server-supplied URL here is validated at its parse boundary;
  // this one was not.
  const rawReplay = str(b.replay_url);
  const replayUrl = /^https:\/\//i.test(rawReplay) ? rawReplay : "";
  return {
    // available:true with no URL is unrenderable — treat it as unavailable
    // rather than offering a link that opens nothing.
    available: available && Boolean(replayUrl),
    replayUrl,
    provider: str(b.provider),
    reason: str(b.reason),
  };
}

// ── unmask ─────────────────────────────────────────────────────────────────

export interface UnmaskResult {
  metadata: Record<string, unknown>;
  unmaskedFields: string[];
}

export function parseUnmaskResult(body: unknown): UnmaskResult {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    metadata:
      b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata)
        ? (b.metadata as Record<string, unknown>)
        : {},
    unmaskedFields: Array.isArray(b.unmaskedFields)
      ? b.unmaskedFields.filter((f): f is string => typeof f === "string")
      : [],
  };
}

/** The server refuses an unmask with no reason recorded? No — it accepts an
 *  empty reason. The CLIENT requires one anyway: an access-trail row that says
 *  nothing about why is a compliance answer nobody can use. */
export function validUnmaskReason(reason: string): boolean {
  return reason.trim().length >= 5;
}

// ── retention override ─────────────────────────────────────────────────────

/** Server bound: 1..3650 days (handlers/audit_extras.go SetRetentionOverride). */
export function validRetentionOverrideDays(days: number): boolean {
  return Number.isInteger(days) && days >= 1 && days <= 3650;
}

/** Preset extensions offered on the phone; anything finer stays on desktop. */
export const RETENTION_OVERRIDE_PRESETS: readonly {
  days: number;
  label: string;
}[] = [
  { days: 365, label: "1 year" },
  { days: 1095, label: "3 years" },
  { days: 2555, label: "7 years" },
];
