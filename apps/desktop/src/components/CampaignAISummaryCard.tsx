/**
 * CampaignAISummaryCard (G17 of the campaigns 2026 pack)
 *
 * Post-send AI summary rendered in CampaignDetailSlideover. Pulls
 * /api/v1/campaigns/{id}/summary; if no row exists (first visit
 * after send), exposes a "Generate summary" CTA that POSTs to
 * /summary/regenerate. The summary is voice-service-authored when a
 * voice client is configured (source="voice"), falling back to the
 * deterministic template (source="deterministic") — open rate vs
 * baseline, top link concentration, reply count + intent buckets,
 * voice-drift advisory. Act-on-suggestion buttons (resend to
 * non-openers, A/B test the subject) are wired by the slideover and
 * gated to editors/admins.
 *
 * Markdown subset: we render **bold**, paragraph breaks, and inline
 * `code` only — no headings, no lists. Keeps the renderer trivial
 * and aligned with the deterministic templates.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type CampaignAISummary, api } from "../lib/api-client";
import { Notice } from "./Notice";
import { toast } from "./Toast";

interface Props {
  campaignId: string | number;
  /** Editor/admin gate — hides the act-on-suggestion buttons for viewers. */
  canMutate?: boolean;
  /** Wired by the slideover: schedule a resend to non-openers (+48h). */
  onResendNonOpeners?: () => void | Promise<void>;
  /** Wired by the slideover: spin up a subject A/B test from this campaign. */
  onABTest?: () => void | Promise<void>;
}

/** Render a single line of the markdown subset. */
function renderInline(line: string): ReactElement[] {
  const out: ReactElement[] = [];
  let cursor = 0;
  // Match the **bold** and `code` runs greedily in left-to-right order.
  const rx = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = rx.exec(line)) != null) {
    if (m.index > cursor) {
      out.push(<span key={`t-${key++}`}>{line.slice(cursor, m.index)}</span>);
    }
    if (m[1] != null) {
      out.push(<strong key={`b-${key++}`}>{m[1]}</strong>);
    } else if (m[2] != null) {
      out.push(
        <code key={`c-${key++}`} className="mono">
          {m[2]}
        </code>,
      );
    }
    cursor = rx.lastIndex;
  }
  if (cursor < line.length) {
    out.push(<span key={`t-${key++}`}>{line.slice(cursor)}</span>);
  }
  return out;
}

function MarkdownBody({ body }: { body: string }): ReactElement {
  const paragraphs = body.split(/\n{2,}/);
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
      {paragraphs.map((p, i) => (
        <p
          key={i}
          style={{
            margin: i === 0 ? "0 0 8px" : "8px 0",
          }}
        >
          {renderInline(p)}
        </p>
      ))}
    </div>
  );
}

interface SummaryFollowUpsProps {
  actionBusy: "resend" | "ab" | null;
  busy: boolean;
  canMutate: boolean;
  onABTest?: (() => void | Promise<void>) | undefined;
  onResendNonOpeners?: (() => void | Promise<void>) | undefined;
  runAction: (
    kind: "resend" | "ab",
    action: () => void | Promise<void>,
  ) => Promise<void>;
}

function SummaryFollowUps({
  actionBusy,
  busy,
  canMutate,
  onABTest,
  onResendNonOpeners,
  runAction,
}: SummaryFollowUpsProps): ReactElement | null {
  if (!onResendNonOpeners && !onABTest) return null;
  if (!canMutate) {
    return (
      <div className="muted small" style={{ marginTop: 8 }}>
        Viewer access can review this summary; an editor can start its suggested
        follow-ups.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
      {onResendNonOpeners ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void runAction("resend", onResendNonOpeners)}
          disabled={busy}
        >
          {actionBusy === "resend"
            ? "Scheduling resend…"
            : "Resend to non-openers in 48h"}
        </button>
      ) : null}
      {onABTest ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void runAction("ab", onABTest)}
          disabled={busy}
        >
          {actionBusy === "ab" ? "Starting A/B test…" : "A/B test the subject"}
        </button>
      ) : null}
    </div>
  );
}

export function CampaignAISummaryCard({
  campaignId,
  canMutate = false,
  onResendNonOpeners,
  onABTest,
}: Props): ReactElement {
  const [summary, setSummary] = useState<CampaignAISummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [actionBusy, setActionBusy] = useState<"resend" | "ab" | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const loadSeqRef = useRef(0);
  const loadBusyRef = useRef(false);
  const regenerateSeqRef = useRef(0);
  const actionSeqRef = useRef(0);
  const regenerateBusyRef = useRef(false);
  const actionBusyRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      loadSeqRef.current += 1;
      regenerateSeqRef.current += 1;
      actionSeqRef.current += 1;
      loadBusyRef.current = false;
      regenerateBusyRef.current = false;
      actionBusyRef.current = false;
    };
  }, []);

  const loadSummary = useCallback(async (): Promise<void> => {
    if (loadBusyRef.current) return;
    loadBusyRef.current = true;
    const request = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.getCampaignSummary(campaignId);
      if (!activeRef.current || request !== loadSeqRef.current) return;
      if (result.error) {
        if (result.error.status === 404) {
          setMissing(true);
          setSummary(null);
          return;
        }
        setLoadError(result.error.message);
        return;
      }
      setSummary(result.data);
      setMissing(false);
    } catch (error) {
      if (activeRef.current && request === loadSeqRef.current) {
        setLoadError(
          error instanceof Error && error.message
            ? error.message
            : "Campaign summary could not be loaded.",
        );
      }
    } finally {
      if (activeRef.current && request === loadSeqRef.current) {
        loadBusyRef.current = false;
        setLoading(false);
      }
    }
  }, [campaignId]);

  useEffect(() => {
    loadSeqRef.current += 1;
    regenerateSeqRef.current += 1;
    actionSeqRef.current += 1;
    loadBusyRef.current = false;
    regenerateBusyRef.current = false;
    actionBusyRef.current = false;
    setSummary(null);
    setMissing(false);
    setOperationError(null);
    setActionBusy(null);
    setRegenerating(false);
    void loadSummary();
  }, [loadSummary]);

  const regenerate = async (): Promise<void> => {
    if (regenerateBusyRef.current || actionBusyRef.current) return;
    regenerateBusyRef.current = true;
    const request = ++regenerateSeqRef.current;
    setRegenerating(true);
    setOperationError(null);
    try {
      const result = await api.regenerateCampaignSummary(campaignId);
      if (!activeRef.current || request !== regenerateSeqRef.current) return;
      if (result.error) {
        setOperationError(result.error.message);
        return;
      }
      setSummary(result.data);
      setMissing(false);
      toast.success("Summary refreshed");
    } catch (error) {
      if (activeRef.current && request === regenerateSeqRef.current) {
        setOperationError(
          error instanceof Error && error.message
            ? error.message
            : "Campaign summary could not be generated.",
        );
      }
    } finally {
      if (activeRef.current && request === regenerateSeqRef.current) {
        regenerateBusyRef.current = false;
        setRegenerating(false);
      }
    }
  };

  const runAction = async (
    kind: "resend" | "ab",
    action: () => void | Promise<void>,
  ): Promise<void> => {
    if (actionBusyRef.current || regenerateBusyRef.current) return;
    actionBusyRef.current = true;
    const request = ++actionSeqRef.current;
    setActionBusy(kind);
    setOperationError(null);
    try {
      await action();
    } catch (error) {
      if (activeRef.current && request === actionSeqRef.current) {
        setOperationError(
          error instanceof Error && error.message
            ? error.message
            : "The suggested action could not be started.",
        );
      }
    } finally {
      if (activeRef.current && request === actionSeqRef.current) {
        actionBusyRef.current = false;
        setActionBusy(null);
      }
    }
  };

  const busy = regenerating || actionBusy !== null;

  if (loading) {
    return (
      <div
        className="campaign-summary-card"
        style={{ marginTop: 16 }}
        role="status"
        aria-live="polite"
      >
        <div className="label">AI summary</div>
        <div className="skel" style={{ height: 80 }} />
        <span className="visually-hidden">Loading campaign summary…</span>
      </div>
    );
  }

  if (loadError && !summary) {
    return (
      <div
        className="campaign-summary-card"
        style={{
          marginTop: 16,
          padding: 12,
          border: "1px solid var(--pw-border)",
          borderRadius: 6,
        }}
      >
        <div className="label">AI summary</div>
        <Notice tone="danger" announcement="assertive">
          Couldn&apos;t load the campaign summary: {loadError}
        </Notice>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void loadSummary()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (missing && !summary) {
    return (
      <div
        className="campaign-summary-card"
        style={{
          marginTop: 16,
          padding: 12,
          border: "1px dashed var(--pw-border)",
          borderRadius: 6,
        }}
      >
        <div className="label">AI summary</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Generate a baseline-aware summary of this campaign&rsquo;s open rate,
          top link, replies, and voice drift.
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void regenerate()}
          disabled={regenerating}
        >
          {regenerating ? "Generating…" : "Generate summary"}
        </button>
        {operationError ? (
          <Notice
            tone="danger"
            announcement="assertive"
            style={{ marginTop: 8 }}
          >
            Couldn&apos;t generate the summary: {operationError}
          </Notice>
        ) : null}
      </div>
    );
  }

  if (!summary) return <></>;

  return (
    <div
      className="campaign-summary-card"
      style={{
        marginTop: 16,
        padding: 12,
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        background: "var(--pw-bg-elev)",
      }}
    >
      <div
        className="label"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        AI summary
        <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>
          ·{" "}
          {summary.source === "voice"
            ? "Voice-authored"
            : "Deterministic fallback"}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void regenerate()}
          disabled={busy}
        >
          {regenerating ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <MarkdownBody body={summary.body_markdown} />
      <SummaryFollowUps
        actionBusy={actionBusy}
        busy={busy}
        canMutate={canMutate}
        onABTest={onABTest}
        onResendNonOpeners={onResendNonOpeners}
        runAction={runAction}
      />
      {operationError ? (
        <Notice tone="danger" announcement="assertive" style={{ marginTop: 8 }}>
          Action failed: {operationError}
        </Notice>
      ) : null}
      <div className="muted" style={{ fontSize: 10, marginTop: 8 }}>
        Generated {new Date(summary.generated_at).toLocaleString()}
      </div>
    </div>
  );
}
