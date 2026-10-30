/**
 * SendChecklist — Workstream 2 (C) pre-send validation panel.
 *
 * Renders the GET /api/v1/campaigns/{id}/checklist response as a
 * pass/warn/fail pill list. Only mounts when the campaign is a draft —
 * post-send the list is irrelevant.
 *
 * Full-surface wiring (2026-06-11) added three client-driven rows
 * beneath the server gate list:
 *   - Accessibility (#3): POST /a11y/check on the current body →
 *     score + findings count, expandable findings list.
 *   - Links (#6): POST /campaigns/{id}/check-links → per-URL status
 *     table; the row fails if any link is broken.
 *   - Send window (#2): POST /send-window/check for the scheduled
 *     time (or "now" for immediate sends) → inside/outside +
 *     enforcement, plus a "Configure" affordance that opens the
 *     policy editor (GET/PUT/DELETE /send-window).
 *
 * The "Refresh" button re-runs every gate — server and client rows —
 * without leaving the slideover so the operator can fix-then-re-verify
 * in a loop.
 */

import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type A11yReport,
  type CampaignChecklist as ChecklistData,
  type CampaignChecklistItem,
  type LinkCheckResult,
  type SendWindowVerdict,
  a11yApi,
  api,
  linkCheckerApi,
  sendWindowApi,
} from "../lib/api-client";
import { PreSendRefinePanel } from "./PreSendRefinePanel";
import { SectionHeader } from "./SectionHeader";
import { SendWindowPolicyModal } from "./composer/SendWindowPolicyModal";
import {
  type ChecklistRowStatus,
  a11yRowDetail,
  a11yRowStatus,
  linkStatusLabel,
  linksRowDetail,
  linksRowStatus,
  sendWindowRowDetail,
  sendWindowRowStatus,
} from "./send-checklist-helpers";

interface Props {
  campaignID: string | number;
  /** Current draft body HTML — feeds the accessibility check. */
  body?: string;
  /** Current subject — also inspected by the a11y rules. */
  subject?: string;
  /** ISO scheduled time; when unset the send-window verdict is
   *  computed for "now" (immediate send). */
  scheduledAt?: string | null;
  /** Editor + admin gate for the send-window policy editor. */
  canMutate?: boolean;
}

function statusPill(status: CampaignChecklistItem["status"]): ReactElement {
  if (status === "pass") return <span className="badge accent">Pass</span>;
  if (status === "warn") return <span className="badge warning">Warn</span>;
  return <span className="badge danger">Fail</span>;
}

/** Loading / error / loaded envelope for one client-side row. */
interface RowState<T> {
  loading: boolean;
  err: string | null;
  data: T | null;
}

const IDLE: RowState<never> = { loading: false, err: null, data: null };

export function SendChecklist({
  campaignID,
  body = "",
  subject = "",
  scheduledAt = null,
  canMutate = false,
}: Props): ReactElement {
  const [data, setData] = useState<ChecklistData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [a11y, setA11y] = useState<RowState<A11yReport>>(IDLE);
  const [links, setLinks] = useState<RowState<LinkCheckResult[]>>(IDLE);
  const [win, setWin] = useState<RowState<SendWindowVerdict>>(IDLE);
  const [a11yOpen, setA11yOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);

  // Cancellation generation: the deps include `body` (keystroke-bound),
  // so each effect cycle invalidates every in-flight loader — a stale
  // response must never overwrite a fresher one. Each loader captures
  // the generation at call time and checks it before every setState.
  const genRef = useRef(0);

  const load = async (): Promise<void> => {
    const gen = genRef.current;
    setLoading(true);
    const res = await api.getCampaignChecklist(campaignID);
    if (gen !== genRef.current) return; // stale
    if (res.error) {
      setErr(res.error.message);
      setData(null);
    } else {
      setErr(null);
      setData(res.data);
    }
    setLoading(false);
  };

  const loadA11y = async (): Promise<void> => {
    const gen = genRef.current;
    setA11y((s) => ({ ...s, loading: true, err: null }));
    const res = await a11yApi.check({ html: body, subject: subject || undefined });
    if (gen !== genRef.current) return; // stale
    if (res.error) {
      setA11y({ loading: false, err: res.error.message, data: null });
      return;
    }
    setA11y({ loading: false, err: null, data: res.data });
  };

  const loadLinks = async (): Promise<void> => {
    const gen = genRef.current;
    setLinks((s) => ({ ...s, loading: true, err: null }));
    const res = await linkCheckerApi.check(campaignID);
    if (gen !== genRef.current) return; // stale
    if (res.error) {
      setLinks({ loading: false, err: res.error.message, data: null });
      return;
    }
    setLinks({ loading: false, err: null, data: res.data });
  };

  const loadWindow = async (): Promise<void> => {
    const gen = genRef.current;
    setWin((s) => ({ ...s, loading: true, err: null }));
    const at = scheduledAt ?? new Date().toISOString();
    const res = await sendWindowApi.check(at);
    if (gen !== genRef.current) return; // stale
    if (res.error) {
      setWin({ loading: false, err: res.error.message, data: null });
      return;
    }
    setWin({ loading: false, err: null, data: res.data });
  };

  const refreshAll = (): void => {
    genRef.current++; // cancel anything still in flight
    void load();
    void loadA11y();
    void loadLinks();
    void loadWindow();
  };

  useEffect(() => {
    refreshAll();
    // Re-run the full gate set when the campaign or its inputs change;
    // the cleanup bump cancels the previous cycle's in-flight loaders.
    return () => {
      genRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignID, body, subject, scheduledAt]);

  const anyLoading = loading || a11y.loading || links.loading || win.loading;

  const summary = data ? (
    data.ready ? (
      <span className="badge accent">Ready to send</span>
    ) : (
      <span className="badge warning">Needs attention</span>
    )
  ) : null;

  return (
    <div style={{ marginTop: 16 }}>
      <SectionHeader
        title="Pre-send check"
        description="Every gate runs against the current draft. Fix the fails, then re-run."
        helpText="Mailchimp-style send checklist: from address verified, subject set, body present, audience picked, recipients > 0, unsubscribe link present — plus accessibility, link health, and the tenant send window."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {summary}
            <button
              type="button"
              className="btn btn-sm"
              onClick={refreshAll}
              disabled={anyLoading}
            >
              {anyLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        }
      />

      {err ? (
        <div className="notice">Couldn&apos;t load checklist: {err}</div>
      ) : null}

      {data == null && loading ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Running checks…
        </div>
      ) : data ? (
        <div style={{ display: "grid", gap: 6 }}>
          {data.checks.map((ck) => (
            <div
              key={ck.key}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr 70px",
                gap: 10,
                alignItems: "start",
                padding: "8px 0",
                borderTop: "1px solid var(--pw-border)",
              }}
            >
              <div style={{ minWidth: 14 }}>{statusPill(ck.status)}</div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{ck.label}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {ck.detail}
                </div>
              </div>
              <div className="muted tabular" style={{ fontSize: 11 }}>
                {ck.key}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* ---- client-side rows (a11y / links / send window) ----------- */}
      <div style={{ display: "grid", gap: 6 }}>
        {/* Accessibility (#3) */}
        <ClientRow
          rowKey="a11y"
          label="Accessibility"
          state={a11y}
          status={a11y.data ? a11yRowStatus(a11y.data) : null}
          detail={a11y.data ? a11yRowDetail(a11y.data) : null}
          onRetry={() => void loadA11y()}
          extra={
            a11y.data && a11y.data.findings.length > 0 ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setA11yOpen((v) => !v)}
                aria-expanded={a11yOpen}
              >
                {a11yOpen
                  ? "Hide findings"
                  : `Findings (${a11y.data.findings.length})`}
              </button>
            ) : null
          }
        >
          {a11yOpen && a11y.data ? (
            <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
              {a11y.data.findings.map((f, i) => (
                <div
                  key={`${f.rule}-${i}`}
                  style={{ display: "flex", gap: 8, alignItems: "baseline" }}
                >
                  {statusPill(
                    f.severity === "error"
                      ? "fail"
                      : f.severity === "warn"
                        ? "warn"
                        : "pass",
                  )}
                  <div style={{ fontSize: 12 }}>
                    <span style={{ fontWeight: 600 }}>{f.rule}</span>
                    {f.wcag ? (
                      <span className="muted"> · WCAG {f.wcag}</span>
                    ) : null}
                    <div className="muted">{f.message}</div>
                    {f.snippet ? (
                      <div
                        className="mono muted"
                        style={{
                          fontSize: 10,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: 320,
                        }}
                        title={f.snippet}
                      >
                        {f.snippet}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </ClientRow>

        {/* Links (#6) */}
        <ClientRow
          rowKey="links"
          label="Links"
          state={links}
          status={links.data ? linksRowStatus(links.data) : null}
          detail={links.data ? linksRowDetail(links.data) : null}
          onRetry={() => void loadLinks()}
          extra={
            links.data && links.data.length > 0 ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setLinksOpen((v) => !v)}
                aria-expanded={linksOpen}
              >
                {linksOpen ? "Hide links" : `Links (${links.data.length})`}
              </button>
            ) : null
          }
        >
          {linksOpen && links.data ? (
            <table className="link-table" style={{ marginTop: 6 }}>
              <tbody>
                {links.data.map((l, i) => (
                  <tr key={`${l.url}-${i}`}>
                    <td
                      className="muted"
                      title={l.error ? `${l.url} — ${l.error}` : l.url}
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 260,
                      }}
                    >
                      {l.url}
                    </td>
                    <td className="tabular">{linkStatusLabel(l)}</td>
                    <td>
                      {l.ok ? (
                        <span className="badge accent">OK</span>
                      ) : (
                        <span className="badge danger">Broken</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </ClientRow>

        {/* Send window (#2) */}
        <ClientRow
          rowKey="send_window"
          label="Send window"
          state={win}
          status={win.data ? sendWindowRowStatus(win.data) : null}
          detail={win.data ? sendWindowRowDetail(win.data) : null}
          onRetry={() => void loadWindow()}
          extra={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPolicyOpen(true)}
            >
              Configure
            </button>
          }
        />
      </div>

      {/* SUB-067 — pre-send audience refine: churn-risk suppression with
          a cooling-off re-entry window. Self-loads + hides on 404. */}
      <PreSendRefinePanel campaignID={campaignID} canMutate={canMutate} />

      <SendWindowPolicyModal
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        onChanged={() => void loadWindow()}
        canMutate={canMutate}
      />
    </div>
  );
}

/* ------- one client-driven row ---------------------------------------- */

function ClientRow<T>({
  rowKey,
  label,
  state,
  status,
  detail,
  onRetry,
  extra,
  children,
}: {
  rowKey: string;
  label: string;
  state: RowState<T>;
  status: ChecklistRowStatus | null;
  detail: string | null;
  onRetry: () => void;
  extra?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr 70px",
        gap: 10,
        alignItems: "start",
        padding: "8px 0",
        borderTop: "1px solid var(--pw-border)",
      }}
    >
      <div style={{ minWidth: 14 }}>
        {state.loading ? (
          <span className="badge">…</span>
        ) : state.err ? (
          <span className="badge warning">?</span>
        ) : status ? (
          statusPill(status)
        ) : (
          <span className="badge">—</span>
        )}
      </div>
      <div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
          {extra}
        </div>
        {state.loading ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Checking…
          </div>
        ) : state.err ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Check failed: {state.err}{" "}
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : detail ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {detail}
          </div>
        ) : null}
        {children}
      </div>
      <div className="muted tabular" style={{ fontSize: 11 }}>
        {rowKey}
      </div>
    </div>
  );
}
