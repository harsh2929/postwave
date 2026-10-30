import {
  type ReactElement,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { type DmarcSourceDetail, api } from "../../lib/api-client";
import { Notice } from "../Notice";
import { SlideoverShell } from "../SlideoverShell";

import { parseDmarcSourceDetail } from "./dmarc-contract";

interface Props {
  ip: string;
  domain?: string;
  days: number;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

type SourceResource = {
  detail: DmarcSourceDetail | null;
  error: string | null;
  errorKind: "request" | "contract" | null;
  loading: boolean;
  scopeKey: string;
};

function formatPercent(value: number, messages: number): string {
  if (messages === 0) return "Not observed";
  return `${(value * 100).toFixed(value >= 0.995 ? 2 : 1)}%`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function dispositionLabel(value: string): string {
  if (value === "none") return "Reported none";
  if (value === "quarantine") return "Quarantine";
  if (value === "reject") return "Reject";
  return "Unknown action";
}

export function DmarcSourceSlideover({
  ip,
  domain,
  days,
  onClose,
  returnFocusRef,
}: Props): ReactElement {
  const [retry, setRetry] = useState(0);
  const [resource, setResource] = useState<SourceResource>({
    detail: null,
    error: null,
    errorKind: null,
    loading: true,
    scopeKey: "",
  });
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const retryFocusRef = useRef<HTMLDivElement | null>(null);
  const scopeKey = `${ip}|${domain ?? "*"}|${days}`;

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;
    setResource((previous) => ({
      detail: previous.scopeKey === scopeKey ? previous.detail : null,
      error: null,
      errorKind: null,
      loading: true,
      scopeKey,
    }));

    void (async () => {
      try {
        const result = await api.getDmarcSourceDetail({
          ip,
          ...(domain ? { domain } : {}),
          days,
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== generationRef.current)
          return;
        if (result.error) {
          setResource((previous) => ({
            ...previous,
            error: result.error.message,
            errorKind: "request",
            loading: false,
          }));
          return;
        }
        const parsed = parseDmarcSourceDetail(result.data, {
          ip,
          domain,
          days,
        });
        if (!parsed) {
          setResource((previous) => ({
            ...previous,
            error: "Moosewave rejected an unexpected source-detail payload.",
            errorKind: "contract",
            loading: false,
          }));
          return;
        }
        setResource({
          detail: parsed,
          error: null,
          errorKind: null,
          loading: false,
          scopeKey,
        });
      } catch {
        if (controller.signal.aborted || generation !== generationRef.current)
          return;
        setResource((previous) => ({
          ...previous,
          error:
            "The source-detail request did not complete. Check connectivity and try again.",
          errorKind: "request",
          loading: false,
        }));
      }
    })();

    return () => controller.abort();
  }, [days, domain, ip, retry, scopeKey]);

  const detail = resource.scopeKey === scopeKey ? resource.detail : null;
  const summary = detail?.summary;
  const aligned = summary
    ? summary.dkimPass + summary.spfPass - summary.bothPass
    : null;

  return (
    <SlideoverShell
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="lg"
      className="dmarc-detail-slideover"
      eyebrow="Source evidence"
      title={<code>{ip}</code>}
      subtitle={`${domain || "All available domains"} · ${days}-day window`}
    >
      <div
        ref={retryFocusRef}
        className="dmarc-detail-boundary"
        role="note"
        tabIndex={-1}
      >
        An IP and alignment result do not identify the sender or prove malicious
        intent. Confirm ownership and message flow before changing
        authentication.
      </div>

      {resource.error ? (
        <Notice
          tone={resource.errorKind === "contract" ? "danger" : "warning"}
          title={
            resource.errorKind === "contract"
              ? "Source response withheld"
              : "Source detail could not be refreshed"
          }
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                retryFocusRef.current?.focus();
                setRetry((value) => value + 1);
              }}
            >
              Retry
            </button>
          }
          announcement="polite"
        >
          {resource.error}{" "}
          {detail
            ? "The last contract-valid snapshot for this source remains visible."
            : "No source metrics have been inferred."}
        </Notice>
      ) : null}

      {resource.loading && !detail ? (
        <div
          className="dmarc-detail-loading"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span className="dmarc-spinner" aria-hidden="true" />
          <span>Validating source evidence…</span>
        </div>
      ) : null}

      {detail && summary && aligned !== null ? (
        <>
          <div className="dmarc-detail-scope">
            <span>
              {resource.loading
                ? "Refreshing last contract-valid snapshot"
                : resource.error
                  ? "Stale contract-valid snapshot"
                  : "Contract-valid snapshot"}
            </span>
            <strong>{formatTimestamp(detail.generatedAt)}</strong>
          </div>
          <section
            className="dmarc-detail-metrics"
            aria-label="Source message summary"
          >
            <div>
              <span>Messages</span>
              <strong>{summary.messages.toLocaleString()}</strong>
            </div>
            <div>
              <span>Aligned</span>
              <strong>
                {formatPercent(summary.alignedPct, summary.messages)}
              </strong>
              <small>
                {summary.messages === 0
                  ? "No denominator"
                  : `${aligned.toLocaleString()} ${aligned === 1 ? "message" : "messages"}`}
              </small>
            </div>
            <div
              data-tone={
                summary.rejected + summary.quarantined > 0
                  ? "negative"
                  : undefined
              }
            >
              <span>Primary action</span>
              <strong>{dispositionLabel(summary.primaryDisposition)}</strong>
              <small>
                {summary.quarantined.toLocaleString()} quarantine ·{" "}
                {summary.rejected.toLocaleString()} reject
              </small>
            </div>
          </section>

          {summary.envelopeFromDomain ? (
            <section
              className="dmarc-detail-section"
              aria-labelledby="dmarc-envelope-domain"
            >
              <p className="dmarc-kicker">Observed identifier</p>
              <h3 id="dmarc-envelope-domain">Envelope-from domain</h3>
              <code className="dmarc-breakable">
                {summary.envelopeFromDomain}
              </code>
              <p className="dmarc-detail-footnote">
                Only the canonical hostname is exposed. Mailbox local-parts are
                intentionally withheld, and this is not a complete identity
                inventory.
              </p>
            </section>
          ) : null}

          <section
            className="dmarc-detail-section"
            aria-labelledby="dmarc-source-contributions"
          >
            <div className="dmarc-detail-section__heading">
              <div>
                <p className="dmarc-kicker">Report contributions</p>
                <h3 id="dmarc-source-contributions">Per-report breakdown</h3>
              </div>
              <span className="dmarc-evidence-pill">
                {detail.hasMore ? "Partial list" : "Complete list"}
              </span>
            </div>
            {detail.hasMore ? (
              <Notice
                tone="warning"
                title="Per-report list is partial"
                announcement="off"
              >
                Source totals cover the complete scope; the table stops at the
                endpoint limit. No continuation cursor is available in this
                build, so this breakdown must not be treated as a complete
                per-report inventory.
              </Notice>
            ) : null}
            {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- This named, horizontally scrollable evidence region must be keyboard-reachable at high zoom. */}
            <div
              className="dmarc-source-report-table"
              tabIndex={0}
              role="region"
              aria-label="Per-report source contributions"
            >
              <table>
                <caption className="visually-hidden">
                  Per-report source contributions
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Reporting organization</th>
                    <th scope="col">Period</th>
                    <th scope="col">Messages</th>
                    <th scope="col">Aligned</th>
                    <th scope="col">Primary action</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.perReport.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        No per-report rows were returned for this validated
                        scope.
                      </td>
                    </tr>
                  ) : (
                    detail.perReport.map((report) => (
                      <tr key={report.reportId}>
                        <th scope="row">
                          {report.orgName}
                          <span className="sr-only">
                            {` · report receipt ${report.reportId}`}
                          </span>
                        </th>
                        <td>
                          {formatDate(report.dateBegin)} –{" "}
                          {formatDate(report.dateEnd)}
                        </td>
                        <td>{report.messages.toLocaleString()}</td>
                        <td>
                          {formatPercent(report.alignedPct, report.messages)}
                        </td>
                        <td>{dispositionLabel(report.primaryDisposition)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
          </section>
        </>
      ) : null}
    </SlideoverShell>
  );
}
