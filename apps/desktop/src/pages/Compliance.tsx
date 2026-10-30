/**
 * Compliance — multi-framework attestation tracker.
 *
 * Top level:
 *   • Posture strip (X of N attested + N due for renewal).
 *   • Grid of supported FrameworkCards plus an informational HIPAA policy
 *     card. Click → detail panel below.
 *
 * Detail panel:
 *   • HIPAA → states that Moosewave offers no BAA and prohibits PHI use.
 *   • Other frameworks → generic detail panel (status, gate
 *     checklist, attest/revoke buttons + AttestModal, event ledger).
 *
 * The HIPAA card is deliberately informational and exposes no mutation or
 * readiness flow. Historical BAA metadata is not treated as authorization.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AttestModal } from "../components/compliance/AttestModal";
import { ConfirmModal } from "../components/ConfirmModal";
import { FrameworkCard } from "../components/compliance/FrameworkCard";
import {
  FRAMEWORK_META,
  metaFor,
  type FrameworkMeta,
} from "../components/compliance/FrameworkMeta";
import { IntegrityPanel } from "../components/compliance/IntegrityPanel";
import { Card } from "../components/Card";
import { ExternalLink } from "../components/ExternalLink";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { InlineHelp } from "../components/InlineHelp";
import { Modal, ModalFooter } from "../components/Modal";
import { Notice } from "../components/Notice";
import { SectionHeader } from "../components/SectionHeader";
import { StatStrip, type StatCell } from "../components/StatStrip";
import { toast } from "../components/Toast";
import {
  type ComplianceEvent,
  type ComplianceFramework,
  type ComplianceProgram,
  api,
} from "../lib/api-client";
import { fmtDateTime } from "../lib/format-date";
import { saveFile } from "../lib/file-transfer";
import { HERO } from "../lib/heroAssets";
import { useCanAdmin } from "../lib/store";
import { useDraftLifecycleController } from "../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../hooks/useSettingsDraftLifecycle";
import "../styles-compliance.css";

export function Compliance(): ReactElement {
  const activeRef = useRef(true);
  const loadRequestRef = useRef(0);
  const canAdmin = useCanAdmin();
  const [programs, setPrograms] = useState<ComplianceProgram[] | null>(null);
  const [selected, setSelected] = useState<ComplianceFramework | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadPrograms = useCallback(async (): Promise<void> => {
    const requestId = ++loadRequestRef.current;
    const res = await api.listCompliancePrograms();
    if (!activeRef.current || requestId !== loadRequestRef.current) return;
    if (res.error) {
      // Non-blocking: the grid still renders from FRAMEWORK_META.
      setErr(res.error.message);
      return;
    }
    setErr(null);
    setPrograms(res.data?.programs ?? []);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void loadPrograms();
    return () => {
      activeRef.current = false;
      loadRequestRef.current += 1;
    };
  }, [loadPrograms]);

  // Display order — FRAMEWORK_META gives us the canonical order;
  // anything the server returns that isn't in our catalogue appends
  // at the end (defensive: future frameworks shouldn't break the UI).
  //
  // Resilience: the grid ALWAYS renders the canonical 8 framework
  // cards from FRAMEWORK_META, even if the API call fails or the
  // backend isn't deployed yet. Server data layers on top to show
  // real status. This keeps the tab usable on a stale/dev build —
  // the operator can still see what each framework is about and
  // (when the backend lands) attest to it.
  const orderedPrograms = useMemo<ComplianceProgram[]>(() => {
    const serverByFw = new Map<string, ComplianceProgram>();
    if (programs) {
      for (const p of programs) serverByFw.set(p.framework, p);
    }
    const known = FRAMEWORK_META.map(
      (m) =>
        serverByFw.get(m.slug) ??
        ({
          framework: m.slug,
          status: m.slug === "hipaa" ? "unsupported" : "in_progress",
        } as ComplianceProgram),
    );
    const extras = (programs ?? []).filter(
      (p) => !FRAMEWORK_META.some((m) => m.slug === p.framework),
    );
    return [...known, ...extras];
  }, [programs]);

  // Posture summary for the header strip.
  const posture = useMemo(() => {
    const supported = orderedPrograms.filter((p) => p.status !== "unsupported");
    const total = supported.length;
    const attested = supported.filter((p) => p.status === "attested").length;
    const overdue = supported.filter((p) => {
      if (p.status !== "attested" || !p.renewalAt) return false;
      const t = new Date(p.renewalAt).getTime();
      return Number.isFinite(t) && t < Date.now();
    }).length;
    const pending = total - attested;
    return { total, attested, overdue, pending };
  }, [orderedPrograms]);

  const postureCells = useMemo<StatCell[]>(() => {
    return [
      {
        label: "Supported frameworks",
        value: <span className="tabular">{posture.total}</span>,
        hint: "Compliance frameworks available for attestation in this workspace.",
      },
      {
        label: "Attested",
        value: (
          <span className="tabular">
            {posture.attested}
            <span
              className="muted"
              style={{ fontSize: "0.7em", marginLeft: 4 }}
            >
              / {posture.total}
            </span>
          </span>
        ),
        hint: "Frameworks with a current, signed attestation on file.",
      },
      {
        label: "Pending",
        value: <span className="tabular">{posture.pending}</span>,
        hint: "Frameworks that have not yet been attested in this workspace.",
      },
      {
        label: "Overdue",
        value: (
          <span
            className={`tabular${posture.overdue > 0 ? " compliance-overdue" : ""}`}
          >
            {posture.overdue}
          </span>
        ),
        hint: "Attested frameworks whose renewal date has passed.",
      },
    ];
  }, [posture]);

  return (
    <div className="page page-with-pad">
      <div className="page-header">
        <div>
          <h1>Compliance</h1>
          <p className="muted" style={{ fontSize: 13 }}>
            Track supported attestations across SOC 2, GDPR, CCPA, PCI DSS, ISO
            27001, CAN-SPAM, and CASL. HIPAA is shown only to make the no-BAA
            and no-PHI policy explicit.
          </p>
        </div>
      </div>

      <StatStrip cells={postureCells} />

      {err ? (
        <Notice
          tone="danger"
          title="Live status unavailable"
          style={{ marginBottom: 12 }}
        >
          {err}. Showing the framework catalogue with default state — click any
          framework to open its detail.
        </Notice>
      ) : null}

      {programs !== null && posture.attested === 0 ? (
        <HeroEmptyState
          tone="blue"
          eyebrow="Compliance"
          title="Compliance, as a dashboard."
          subtitle="Track supported compliance attestations in one grid. Moosewave does not offer a BAA and must not be used for PHI."
          imageSrc={HERO.compliance}
          imageAlt="An embossed certificate with a teal wax seal"
        />
      ) : null}

      <div className="compliance-grid">
        {orderedPrograms.map((p) => (
          <FrameworkCard
            key={p.framework}
            program={p}
            onOpen={() => setSelected(p.framework)}
          />
        ))}
      </div>

      {selected ? (
        <div className="compliance-detail">
          {selected === "hipaa" ? (
            <HIPAADetail />
          ) : (
            <GenericFrameworkDetail
              key={selected}
              framework={selected}
              canAdmin={canAdmin}
              onChange={() => void loadPrograms()}
            />
          )}
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSelected(null)}
            >
              Close detail
            </button>
          </div>
        </div>
      ) : null}

      {/* Integrity tab — Merkle inclusion + consistency proofs over
          the audit log (CryptoAnchor P0). Always visible at the bottom
          of the Compliance page so auditors can drill in without
          opening a framework detail. */}
      <IntegrityPanel />

      {/* Retention activity — per-batch audit.retention.purge events
          emitted by the trim worker, with before-trim Merkle root hash
          so a verifier can prove the purge happened against a known
          tree state (retention-trail-archive, Compliance P1). */}
      <RetentionActivityPanel />

      {/* aivs-bundles (Compliance, P2): EU AI Act Article 50 readiness
          checklist + AIVS bundle helper. Surfaces transparency posture
          for AI-generated content + signpost the offline verifier. */}
      <Article50ReadinessPanel />
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Article50ReadinessPanel — EU AI Act Article 50 transparency posture.
 *
 * Surfaces a readiness checklist + a one-shot bundle export so a
 * compliance officer can attach the proof bundle to an inspection
 * response without leaving the page. Counts agent-actor events in the
 * last 30 days via the existing /audit/stats endpoint so the checklist
 * shows live data ("12 agent events this month") rather than a static
 * green tick.
 * -------------------------------------------------------------------- */

function Article50ReadinessPanel(): ReactElement {
  const [agentEvents, setAgentEvents] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sessionInput, setSessionInput] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [bundleErr, setBundleErr] = useState<string | null>(null);
  const [bundleDone, setBundleDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const since = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const res = await api.getAuditStats({ actorType: "agent", since });
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        return;
      }
      setErr(null);
      setAgentEvents(res.data?.totalEvents ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBundleDownload = async (): Promise<void> => {
    const sid = sessionInput.trim();
    if (!sid) return;
    setBusy(true);
    setBundleErr(null);
    setBundleDone(null);
    const res = await api.downloadAIVSBundle(sid);
    setBusy(false);
    if (res.error) {
      setBundleErr(
        res.error.code === "no_agent_events"
          ? "No AI agent events found for this session."
          : (res.error.message ?? "Unable to build bundle."),
      );
      return;
    }
    if (!res.data) {
      setBundleErr("Empty response.");
      return;
    }
    const saved = await saveFile({
      data: res.data.blob,
      suggestedName: res.data.filename,
      label: "AIVS proof bundle",
      privacy: "confidential",
      mimeType: "application/zip",
    });
    if (!saved.ok) {
      setBundleErr(saved.message);
      return;
    }
    if (saved.status !== "cancelled") {
      setBundleDone(`Saved ${res.data.filename}`);
    }
  };

  // Honesty split: only the agent-activity row is a live check
  // (driven by /audit/stats). The rest describe what the platform
  // ships — they are NOT verified per-tenant at render time, so they
  // render as informational capability rows, not green ticks.
  const items: Array<
    | { kind: "check"; ok: boolean; label: string; detail: string }
    | { kind: "info"; label: string; detail: string }
  > = [
    {
      kind: "check",
      ok: (agentEvents ?? 0) > 0,
      label: "Agent activity observed in the last 30 days",
      detail:
        agentEvents == null
          ? "Loading…"
          : `${agentEvents.toLocaleString()} agent-actor event` +
            `${agentEvents === 1 ? "" : "s"} in the trailing 30-day window.`,
    },
    {
      kind: "info",
      label: "AI agent audit logging",
      detail:
        "Every agent-actor (claude-code, postwave-ai, etc.) action is " +
        "recorded with actor_type='agent' on audit_log.",
    },
    {
      kind: "info",
      label: "AIVS proof bundles available per session",
      detail:
        "GET /api/v1/audit/ai-session/{session_id}/aivs-bundle returns a " +
        ".tar.gz with manifest.json, events.jsonl, chain.json, verify.py.",
    },
    {
      kind: "info",
      label: "Model ID + tool calls captured per row",
      detail:
        "Agent metadata schema reserves prompt_hash, model_id, tool_calls, " +
        "output_hash — populated when handlers attach AI context.",
    },
    {
      kind: "info",
      label: "Offline verifier (verify.py) shipped in every bundle",
      detail:
        "Python 3 stdlib-only, ~150 LOC. SHA-256 chain + Ed25519 signature " +
        "verification against the manifest-embedded public key.",
    },
  ];

  return (
    <div style={{ marginTop: 24 }} data-testid="article50-readiness-panel">
      <SectionHeader
        title="Article 50 transparency (EU AI Act)"
        description="Readiness checklist for AI-generated content disclosure under EU AI Act Article 50. AIVS bundles give regulators a portable, offline-verifiable proof that AI agent actions in the system match what was logged."
        actions={
          <InlineHelp text="Article 50 obliges providers of AI systems generating content to disclose AI involvement and keep records sufficient for downstream verification. Moosewave's AIVS bundles satisfy the record-keeping requirement; the disclosure copy on emitted emails is enforced by the compose pipeline." />
        }
      />
      {err ? (
        <Notice tone="warning" style={{ marginTop: 12 }}>
          Live readiness signal unavailable: {err}
        </Notice>
      ) : null}
      <ul
        style={{
          listStyle: "none",
          paddingLeft: 0,
          marginTop: 12,
          display: "grid",
          gap: 8,
        }}
      >
        {items.map((it) => (
          <li key={it.label}>
            <Card variant="subtle" padding="sm">
              <div
                style={{ display: "flex", gap: 10, alignItems: "flex-start" }}
              >
                <span
                  aria-hidden="true"
                  className={`compliance-readiness-icon${
                    it.kind === "check" && it.ok ? " is-complete" : ""
                  }`}
                >
                  {it.kind === "check" ? (it.ok ? "✓" : "·") : "i"}
                </span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {it.label}
                    {it.kind === "info" ? (
                      <span
                        className="muted"
                        style={{ fontSize: 11, fontWeight: 400, marginLeft: 6 }}
                      >
                        · platform capability (informational)
                      </span>
                    ) : null}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    {it.detail}
                  </div>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <Card
        variant="subtle"
        padding="md"
        title="Export AIVS bundle for an inspector"
        style={{ marginTop: 12 }}
      >
        <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
          Paste a session_id (visible in the audit slideover for agent rows) to
          download the signed proof bundle straight from this page.
        </div>
        <div
          className="row"
          style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}
        >
          <input
            type="text"
            className="input"
            placeholder="session_id…"
            value={sessionInput}
            onChange={(e) => setSessionInput(e.target.value)}
            style={{ width: 240, fontSize: 12 }}
            data-testid="article50-session-input"
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => void handleBundleDownload()}
            disabled={busy || !sessionInput.trim()}
            data-testid="article50-bundle-download"
          >
            {busy ? "Building bundle…" : "Download AIVS bundle"}
          </button>
        </div>
        {bundleErr ? (
          <Notice tone="danger" style={{ marginTop: 6 }}>
            {bundleErr}
          </Notice>
        ) : null}
        {bundleDone && !bundleErr ? (
          <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
            {bundleDone}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Retention activity — timeline of audit.retention.purge events.
 *
 * Sources audit_retention_purge_events via /audit/retention-activity.
 * Each row is one batch the trim worker deleted; before_root_hash
 * pins the Merkle root snapshot taken before the delete so an
 * external verifier can prove the purge took place after a known
 * tree state. Cleanly degrades to an empty state when the trimmer
 * hasn't run yet (no rows; fresh tenant).
 * -------------------------------------------------------------------- */

function RetentionActivityPanel(): ReactElement {
  const [events, setEvents] = useState<
    Array<{
      id: number;
      action: string;
      deleted_id_range: string;
      deleted_count: number;
      retention_days: number;
      before_root_hash: string;
      at: string;
    }>
  >([]);
  const [total30d, setTotal30d] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    const res = await api.listRetentionActivity({ limit: 200 });
    setLoading(false);
    if (res.error) {
      setErr(res.error.message);
      return;
    }
    setErr(null);
    setEvents(res.data?.events ?? []);
    setTotal30d(res.data?.total_purged_last_30d ?? 0);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div style={{ marginTop: 24 }}>
      <SectionHeader
        title="Retention activity"
        description="Every batch the audit-log retention sweeper deletes is itself recorded as an immutable audit.retention.purge event. The before-trim Merkle root hash pins the tree state at the moment of deletion so an external verifier can prove the purge took place after a known checkpoint."
        actions={
          <InlineHelp text="Purge events are themselves never trimmed (carved out of the WHERE clause). Legal-hold flips on individual rows are recorded as audit.retention.override_set events on the regular audit timeline." />
        }
      />
      <StatStrip
        cells={
          [
            {
              label: "Rows purged (last 30d)",
              value: (
                <span className="tabular">{total30d.toLocaleString()}</span>
              ),
            },
            {
              label: "Purge batches recorded",
              value: <span className="tabular">{events.length}</span>,
            },
          ] as StatCell[]
        }
      />
      {err ? (
        <Notice tone="warning" style={{ marginTop: 12 }}>
          Failed to load retention activity: {err}
        </Notice>
      ) : null}
      {loading ? (
        <p className="muted">Loading retention activity…</p>
      ) : events.length === 0 ? (
        <p className="muted">
          No retention-purge events recorded yet. The sweeper runs on a 24-hour
          interval; the first batch will appear here once stale rows exist.
        </p>
      ) : (
        <table className="data-table" style={{ width: "100%", marginTop: 12 }}>
          <thead>
            <tr>
              <th>When</th>
              <th>Deleted rows</th>
              <th>ID range</th>
              <th>Retention window</th>
              <th>Pre-purge root</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id}>
                <td>{fmtDateTime(ev.at)}</td>
                <td className="tabular">{ev.deleted_count.toLocaleString()}</td>
                <td className="tabular small muted">{ev.deleted_id_range}</td>
                <td className="tabular">{ev.retention_days}d</td>
                <td
                  className="tabular small muted"
                  title={ev.before_root_hash || "(no root yet)"}
                >
                  {ev.before_root_hash
                    ? `${ev.before_root_hash.slice(0, 12)}…`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------
 * HIPAA policy — informational only.
 * -------------------------------------------------------------------- */

function HIPAADetail(): ReactElement {
  return (
    <div>
      <SectionHeader
        title="HIPAA is not supported"
        description="Moosewave does not offer or execute Business Associate Agreements."
        helpText="A BAA is required before a service provider may handle PHI on behalf of a HIPAA covered entity."
      />
      <Notice tone="danger" style={{ marginTop: 12 }}>
        Do not upload, store, process, or send Protected Health Information
        (PHI) through Moosewave. Encryption keys, retention settings, or legacy
        HIPAA use is unsupported, regardless of any historical BAA records.
      </Notice>
      <p className="muted" style={{ marginTop: 12 }}>
        Historical BAA metadata is retained for recordkeeping only. It is not an
        active agreement, cannot be changed in the product, and does not
        authorize PHI use.
      </p>
    </div>
  );
}

interface FrameworkDetailHeaderProps {
  meta: FrameworkMeta;
  program: ComplianceProgram | null;
  programError: string | null;
  canAdmin: boolean;
  onAttest: () => void;
  onRevoke: () => void;
}

function FrameworkDetailHeader({
  meta,
  program,
  programError,
  canAdmin,
  onAttest,
  onRevoke,
}: FrameworkDetailHeaderProps): ReactElement {
  const attested = program?.status === "attested";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 8,
      }}
    >
      <div>
        <h2 style={{ margin: 0 }}>
          {meta.short}
          <span style={{ marginLeft: 6 }}>
            <InlineHelp
              text={`${meta.full}. ${meta.blurb}`}
              ariaLabel={`About ${meta.short}`}
            />
          </span>
          <span
            className="muted"
            style={{ fontSize: 13, fontWeight: 400, marginLeft: 8 }}
          >
            · {meta.region}
          </span>
        </h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {meta.full}
        </p>
        {meta.url ? (
          <ExternalLink href={meta.url} className="muted small">
            Official reference →
          </ExternalLink>
        ) : null}
      </div>
      {/* Unknown status must fail closed: never sign or revoke blind. */}
      {programError ? null : (
        <div style={{ display: "flex", gap: 8 }}>
          {attested ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={!canAdmin}
                onClick={onAttest}
              >
                Record renewal
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!canAdmin}
                onClick={onRevoke}
              >
                Revoke
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canAdmin}
              onClick={onAttest}
            >
              Attest
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FrameworkReadinessPanel({
  meta,
  program,
  programError,
  onRetry,
}: {
  meta: FrameworkMeta;
  program: ComplianceProgram | null;
  programError: string | null;
  onRetry: () => void;
}): ReactElement {
  if (programError) {
    return (
      <Notice
        tone="danger"
        style={{ marginTop: 12 }}
        action={
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        }
      >
        Couldn&apos;t load the {meta.short} attestation status: {programError}
      </Notice>
    );
  }

  const attested = program?.status === "attested";
  return (
    <Notice
      tone={attested ? "success" : "warning"}
      style={{ marginTop: 12 }}
      title={
        <h3 style={{ margin: 0, fontSize: "var(--pw-text-body)" }}>
          {attested
            ? `✓ ${meta.short} attestation recorded`
            : `${meta.short} not attested`}
        </h3>
      }
    >
      {meta.gates.length > 0 ? (
        <>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {attested
              ? "The signer affirmed the gates below when attesting. Moosewave records the attestation; it does not verify each gate individually."
              : "Gates the signer affirms when recording an attestation:"}
          </div>
          <ul className="compliance-gate-list">
            {meta.gates.map((gate) => (
              <li key={gate}>
                <span className="compliance-gate-marker">○</span> {gate}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {program?.attestedAt ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Attested {fmtDateTime(program.attestedAt)}.{" "}
          {program.renewalAt ? (
            <>Next renewal: {fmtDateTime(program.renewalAt)}.</>
          ) : null}
        </div>
      ) : null}
      {program?.signedByEmail ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Signer: {program.signedByEmail}
          {program.signerName
            ? ` (counter-signed by ${program.signerName})`
            : ""}
          .
          {program.documentPath ? (
            <>
              {" "}
              Document: <span className="mono">{program.documentPath}</span>
            </>
          ) : null}
        </div>
      ) : null}
    </Notice>
  );
}

function FrameworkEventLedger({
  meta,
  events,
  eventError,
  onRetry,
}: {
  meta: FrameworkMeta;
  events: ComplianceEvent[];
  eventError: string | null;
  onRetry: () => void;
}): ReactElement {
  return (
    <>
      <SectionHeader
        title="Event ledger"
        description={`Immutable record of attestation activity for ${meta.short}. Auditors rely on this for chain-of-custody.`}
        helpText="Every sign / revoke / renewal event is appended here with signer and timestamp. Rows are write-once."
      />
      {eventError ? (
        <Notice
          tone="danger"
          style={{ marginTop: 12 }}
          action={
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          }
        >
          Couldn&apos;t load the {meta.short} event ledger: {eventError}
        </Notice>
      ) : events.length === 0 ? (
        <p className="muted">No events yet for {meta.short}.</p>
      ) : (
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Signer</th>
              <th>Counter-signed</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{fmtDateTime(event.at)}</td>
                <td>
                  <span className="badge">{event.eventType}</span>
                </td>
                <td>{event.signedByEmail || "—"}</td>
                <td>{event.counterSignedBy || "—"}</td>
                <td style={{ fontSize: 12 }} className="muted">
                  {event.notes || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function RevokeFrameworkModal({
  meta,
  busy,
  reason,
  onReasonChange,
  onClose,
  onConfirm,
}: {
  meta: FrameworkMeta;
  busy: boolean;
  reason: string;
  onReasonChange: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  return (
    <Modal
      open={true}
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      title={`Revoke ${meta.short} attestation?`}
      description={`The workspace will lose its ${meta.short} status until a new attestation is recorded. The ledger keeps a permanent record.`}
    >
      <div className="field">
        <label className="field-label" htmlFor="revoke-reason">
          Reason (optional)
        </label>
        <textarea
          id="revoke-reason"
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          rows={3}
          disabled={busy}
          placeholder="Contract terminated, scope change, etc."
        />
      </div>
      <ModalFooter>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Revoking…" : `Revoke ${meta.short}`}
        </button>
      </ModalFooter>
    </Modal>
  );
}
/* ----------------------------------------------------------------------
 * Generic framework detail — SOC 2, GDPR, CCPA, PCI DSS, ISO 27001,
 * CAN-SPAM, CASL share this surface.
 * -------------------------------------------------------------------- */

function GenericFrameworkDetail({
  framework,
  canAdmin,
  onChange,
}: {
  framework: ComplianceFramework;
  canAdmin: boolean;
  onChange: () => void;
}): ReactElement {
  const activeRef = useRef(true);
  const loadRequestRef = useRef(0);
  const actionRequestRef = useRef(0);
  const meta = metaFor(framework);
  const [program, setProgram] = useState<ComplianceProgram | null>(null);
  const [events, setEvents] = useState<ComplianceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [progErr, setProgErr] = useState<string | null>(null);
  const [evErr, setEvErr] = useState<string | null>(null);
  const [showAttest, setShowAttest] = useState(false);
  const [showRevoke, setShowRevoke] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");

  const load = useCallback(async (): Promise<boolean> => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    // Reset cross-framework state up-front. The effect below re-runs
    // this loader on every `framework` change — without the reset the
    // previous framework's attestation + ledger rendered under the new
    // framework's name while (or after, on partial failure) the fetch
    // was in flight.
    setProgram(null);
    setEvents([]);
    setProgErr(null);
    setEvErr(null);
    const [progRes, evRes] = await Promise.all([
      api.getComplianceProgram(framework),
      api.listComplianceEvents(framework),
    ]);
    if (!activeRef.current || requestId !== loadRequestRef.current) {
      return false;
    }
    setLoading(false);
    // Surface load errors inline, per panel — pre-fix a failure was
    // silently swallowed, leaving stale cross-framework data (or an
    // empty state indistinguishable from "not attested yet") on a
    // compliance surface.
    if (progRes.error) setProgErr(progRes.error.message);
    else setProgram(progRes.data ?? null);
    if (evRes.error) setEvErr(evRes.error.message);
    else setEvents(evRes.data?.events ?? []);
    return true;
  }, [framework]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      loadRequestRef.current += 1;
      actionRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    actionRequestRef.current += 1;
    setShowAttest(false);
    setShowRevoke(false);
    setRevokeReason("");
    void load();
  }, [load]);

  /**
   * Revoke flow — uses a dedicated Modal instead of window.prompt
   * (v1 was a tiny browser dialog with no styling and no scope).
   * The reason input is multiline + scoped to the framework so the
   * ledger entry has structured context.
   */
  const onRevoke = async (): Promise<boolean> => {
    if (!program?.updatedAt) {
      toast.error({
        message: `Couldn't revoke ${meta.short} attestation`,
        detail:
          "The exact stored revision is unavailable. Refresh before revoking; nothing was written.",
      });
      return false;
    }
    const requestId = ++actionRequestRef.current;
    const targetMeta = meta;
    const res = await api.revokeComplianceProgram(
      framework,
      revokeReason.trim(),
      program.updatedAt,
    );
    if (!activeRef.current || requestId !== actionRequestRef.current) {
      return !res.error;
    }
    if (res.error) {
      toast.error({
        message: `Couldn't revoke ${targetMeta.short} attestation`,
        detail: res.error.code
          ? `[${res.error.code}] ${res.error.message}`
          : res.error.message,
      });
      return false;
    }
    toast.success(`${targetMeta.short} attestation revoked`);
    setShowRevoke(false);
    setRevokeReason("");
    void load().then((loaded) => {
      if (
        loaded &&
        activeRef.current &&
        requestId === actionRequestRef.current
      ) {
        onChange();
      }
    });
    return true;
  };

  const revokeLifecycle = useDraftLifecycleController({
    ownerId: `compliance-revoke-${framework}`,
    label: `${meta.short} attestation revocation draft`,
    mode: "action",
    enabled: showRevoke,
    dirty: Boolean(revokeReason.trim()),
    save: onRevoke,
    discard: () => setRevokeReason(""),
    close: () => setShowRevoke(false),
    detail:
      "This attestation revocation reason has not been submitted. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the attestation revocation request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error({
        message: `Couldn't revoke ${meta.short} attestation`,
        detail: lifecycleOperationError(error, "The revoke request failed."),
      }),
  });

  const reloadAfterAttestation = async (): Promise<void> => {
    setShowAttest(false);
    const requestId = actionRequestRef.current;
    const loaded = await load();
    if (loaded && activeRef.current && requestId === actionRequestRef.current) {
      onChange();
    }
  };

  if (loading) {
    return <p className="muted">Loading {meta.short}…</p>;
  }
  if (progErr && evErr) {
    return (
      <Notice
        tone="danger"
        style={{ marginTop: 12 }}
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
          >
            Retry
          </button>
        }
      >
        Couldn&apos;t load {meta.short}: {progErr}
      </Notice>
    );
  }

  return (
    <div>
      <FrameworkDetailHeader
        meta={meta}
        program={program}
        programError={progErr}
        canAdmin={canAdmin}
        onAttest={() => setShowAttest(true)}
        onRevoke={() => setShowRevoke(true)}
      />

      <p style={{ fontSize: 13, marginTop: 8 }}>{meta.blurb}</p>

      <FrameworkReadinessPanel
        meta={meta}
        program={program}
        programError={progErr}
        onRetry={() => void load()}
      />

      <hr style={{ margin: "20px 0" }} />

      <FrameworkEventLedger
        meta={meta}
        events={events}
        eventError={evErr}
        onRetry={() => void load()}
      />

      {showAttest ? (
        <AttestModal
          meta={meta}
          expectedUpdatedAt={program?.updatedAt}
          onClose={() => setShowAttest(false)}
          onDone={reloadAfterAttestation}
        />
      ) : null}

      {showRevoke ? (
        <RevokeFrameworkModal
          meta={meta}
          busy={revokeLifecycle.active}
          reason={revokeReason}
          onReasonChange={setRevokeReason}
          onClose={revokeLifecycle.requestClose}
          onConfirm={() => void revokeLifecycle.submit()}
        />
      ) : null}
      <ConfirmModal
        open={revokeLifecycle.discardConfirmOpen}
        title="Discard revocation reason?"
        description={`The ${meta.short} attestation has not been revoked.`}
        confirmLabel="Discard reason"
        danger
        busy={revokeLifecycle.active}
        onConfirm={revokeLifecycle.discardAndClose}
        onClose={revokeLifecycle.keepEditing}
      />
    </div>
  );
}
