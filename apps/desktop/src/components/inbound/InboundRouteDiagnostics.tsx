/**
 * Inbound-email provider setup snippets and per-route match history.
 *
 * These diagnostics own copy interactions, provider-specific instructions,
 * history loading, and action-run disclosure outside the route CRUD page.
 */

import { type ReactElement, useId, useRef, useState } from "react";

import { ActionRunsPanel } from "./ActionRunsPanel";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { useClipboardCopy } from "../../hooks/useClipboardCopy";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import { ExternalLink } from "../ExternalLink";
import { toast } from "../Toast";
import { type InboundRouteMatch, api, getApiUrl } from "../../lib/api-client";
import {
  formatInboundRouteAbsolute,
  formatInboundRouteRelative,
} from "./inbound-route-time";

export {
  formatInboundRouteAbsolute,
  formatInboundRouteRelative,
} from "./inbound-route-time";

/* ---------- provider snippets ---------- */

/**
 * Each entry is a copy-pasteable webhook config snippet for a major
 * inbound-mail provider. We deliberately render the snippet inline so
 * operators don't have to leave the page — past pattern (linking to a
 * docs page) had a 30% drop-off rate per support tickets.
 */
export interface ProviderSnippet {
  id: string;
  label: string;
  description: string;
  /** Lines of the snippet rendered inside a <pre>. */
  body: string;
  /** Optional external doc link for the provider's webhook setup. */
  docUrl?: string;
}

export function buildProviderSnippets(slug: string): ProviderSnippet[] {
  // Use the operator's configured API host. Hardcoding api.moosewave.com
  // (the cloud default) meant copy-pasted snippets pointed at the wrong
  // host for self-hosted installs and local dev — the integrations
  // would never receive mail.
  const apiBase = getApiUrl().replace(/\/$/, "");
  const url = slug
    ? `${apiBase}/api/public/inbound-email/${slug}`
    : `${apiBase}/api/public/inbound-email/<slug>`;
  return [
    {
      id: "postmark",
      label: "Postmark",
      description:
        "Postmark can't add our HMAC signature header, so route its inbound webhook through a signing proxy (see snippet). Postmark sends Postmark-shaped JSON, which our ingest auto-detects.",
      docUrl: "https://postmarkapp.com/manual#inbound-webhook",
      // D12-comms-webhooks#10: the endpoint is ALWAYS provisioned with a
      // signing secret, and the ingest handler 401s any request missing a
      // valid timestamped signature. Postmark can't set the required custom
      // headers, so a direct Postmark → Moosewave wiring always fails — use a
      // proxy that signs the exact bytes it forwards.
      body:
        `Required headers:\n` +
        `  X-Postwave-Inbound-Timestamp: <current unix seconds>\n` +
        `  X-Postwave-Inbound-Event-Id: <stable Postmark delivery id>\n` +
        `  X-Postwave-Inbound-Signature:\n` +
        `    hex(hmac-sha256(secret, timestamp + "." + raw_body))\n\n` +
        `Postmark can't add these custom headers, and the ingest\n` +
        `endpoint REJECTS any unsigned request with 401 — so you can\n` +
        `NOT point Postmark at ${url} directly.\n\n` +
        `Route Postmark's inbound webhook through a small proxy\n` +
        `(Lambda / Cloudflare Worker) that signs the exact raw body,\n` +
        `maps Postmark's immutable delivery id, and forwards both with\n` +
        `a fresh timestamp to the URL above.`,
    },
    {
      id: "mailgun",
      label: "Mailgun",
      description:
        "Mailgun → Receiving → Routes → Forward to: the URL below. Mailgun's HTTP store-and-forward POSTs multipart, but our ingest currently expects JSON — use a small Postmark-shaped proxy or configure Mailgun's 'POST as JSON' option.",
      docUrl:
        "https://documentation.mailgun.com/en/latest/user_manual.html#routes",
      body:
        `Action:   forward("${url}")\n` +
        `Proxy headers:\n` +
        `  X-Postwave-Inbound-Timestamp: <current unix seconds>\n` +
        `  X-Postwave-Inbound-Event-Id: <stable Mailgun event id>\n` +
        `  X-Postwave-Inbound-Signature:\n` +
        `    hex(hmac-sha256(secret, timestamp + "." + raw_body))\n\n` +
        `Mailgun's built-in HMAC signs with its own key on a different\n` +
        `header — bridge with a Lambda / Cloudflare Worker and sign\n` +
        `the exact JSON bytes that proxy forwards.`,
    },
    {
      id: "ses",
      label: "AWS SES",
      description:
        "SES + S3 + Lambda is the typical inbound pipeline. The Lambda parses the raw email out of S3 and POSTs a Postmark-shaped JSON envelope to the URL below.",
      docUrl: "https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html",
      body:
        `Endpoint URL:     ${url}\n` +
        `Required headers: X-Postwave-Inbound-Timestamp,\n` +
        `                  X-Postwave-Inbound-Event-Id,\n` +
        `                  X-Postwave-Inbound-Signature\n\n` +
        `Lambda pseudo-code:\n` +
        `  const body = JSON.stringify({\n` +
        `    from:    mail.commonHeaders.from[0],\n` +
        `    to:      mail.commonHeaders.to[0],\n` +
        `    subject: mail.commonHeaders.subject,\n` +
        `    text:    parsedBodyText,\n` +
        `    html:    parsedBodyHtml,\n` +
        `    message_id:  mail.messageId,\n` +
        `    in_reply_to: mail.commonHeaders["in-reply-to"]?.[0],\n` +
        `  });\n` +
        `  const timestamp = Math.floor(Date.now() / 1000).toString();\n` +
        `  const sig = crypto.createHmac("sha256", SECRET)\n` +
        `    .update(timestamp + "." + body).digest("hex");\n` +
        `  await fetch("${url}", { method: "POST", body, headers: {\n` +
        `    "Content-Type": "application/json",\n` +
        `    "X-Postwave-Inbound-Timestamp": timestamp,\n` +
        `    "X-Postwave-Inbound-Event-Id": mail.messageId,\n` +
        `    "X-Postwave-Inbound-Signature": sig,\n` +
        `  }});`,
    },
  ];
}

export function ProviderSnippetsCard({ slug }: { slug: string }): ReactElement {
  const snippets = buildProviderSnippets(slug);
  const [open, setOpen] = useState<string>(snippets[0]?.id ?? "");
  const clipboard = useClipboardCopy();
  const copyFlightRef = useRef(false);
  const tabs = useTabsInteraction({
    value: open,
    items: snippets.map((snippet) => ({ value: snippet.id })),
    onChange: setOpen,
  });

  const copy = async (text: string): Promise<void> => {
    if (copyFlightRef.current) return;
    copyFlightRef.current = true;
    try {
      const result = await clipboard.copy(
        text,
        {
          contentClass: "public",
          label: "Provider snippet",
        },
        "Provider snippet",
      );
      if (result.ok) toast.success("Copied to clipboard");
      else toast.error("The provider snippet couldn't be copied.");
    } catch {
      toast.error(
        "Clipboard access failed. Select the snippet and copy it manually.",
      );
    } finally {
      copyFlightRef.current = false;
    }
  };

  return (
    <details
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: "8px 16px",
        marginBottom: 16,
        background: "var(--pw-bg-elev)",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          padding: "6px 0",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Provider setup snippets
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
          — copy-paste webhook configs for Postmark, Mailgun, AWS SES
        </span>
      </summary>
      <div style={{ paddingBottom: 8 }}>
        <div
          ref={tabs.listRef}
          className="tabbar"
          {...tabs.listProps}
          aria-label="Inbound provider"
          style={{ marginTop: 8 }}
        >
          {snippets.map((s) => (
            <button
              key={s.id}
              type="button"
              {...tabs.getTabProps(s.id)}
              className={open === s.id ? "tab active" : "tab"}
            >
              {s.label}
            </button>
          ))}
        </div>
        {snippets.map((s) => (
          <section
            key={s.id}
            {...tabs.getPanelProps(s.id)}
            style={{ marginTop: 8 }}
          >
            <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>
              {s.description}
              {s.docUrl && (
                <>
                  {" "}
                  <ExternalLink href={s.docUrl}>Provider docs ↗</ExternalLink>
                </>
              )}
            </p>
            <div
              style={{
                position: "relative",
                border: "1px solid var(--pw-border)",
                borderRadius: 6,
                background: "var(--pw-bg)",
              }}
            >
              <button
                type="button"
                onClick={() => void copy(s.body)}
                aria-label={`Copy ${s.label} provider setup snippet`}
                aria-disabled={clipboard.status === "copying" || undefined}
                aria-busy={clipboard.status === "copying" || undefined}
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  fontSize: 11,
                  padding: "2px 8px",
                }}
              >
                {clipboard.status === "copying" ? "Copying…" : "Copy"}
              </button>
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 12,
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  overflowX: "auto",
                }}
              >
                {s.body}
              </pre>
            </div>
          </section>
        ))}
        <span className="visually-hidden" {...clipboard.liveRegionProps}>
          {clipboard.announcement}
        </span>
      </div>
    </details>
  );
}

/* ---------- match-history panel ---------- */

/**
 * Loads + renders the recent firing history for a single rule. Used
 * inside the edit modal as a tab. Empty list ≠ error — a brand new
 * rule simply hasn't fired yet, so we render the empty state with
 * concrete copy rather than a generic "no data".
 */
export function MatchHistoryPanel({
  routeId,
}: {
  routeId: string;
}): ReactElement {
  const retryFlightRef = useRef<Promise<void> | null>(null);
  const history = useRemoteResource<InboundRouteMatch[]>(
    async () => {
      const response = await api.inboundRouteMatchesList(routeId, {
        limit: 50,
      });
      return response.error
        ? { error: response.error }
        : { data: response.data?.matches ?? [] };
    },
    { identity: `inbound-route-matches:${routeId}` },
  );
  const matches = history.data;
  const loading =
    history.transport === "idle" || history.transport === "loading";
  const retry = (): void => {
    if (retryFlightRef.current) return;
    const request = history.reload();
    retryFlightRef.current = request;
    void request.finally(() => {
      if (retryFlightRef.current === request) retryFlightRef.current = null;
    });
  };

  if (matches == null && loading) {
    return (
      <p className="muted" role="status">
        Loading history…
      </p>
    );
  }
  if (matches == null) {
    return (
      <div className="callout error" role="alert">
        <span>
          Couldn&apos;t verify match history: {history.failure?.message}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={loading || undefined}
          aria-busy={loading || undefined}
          onClick={retry}
        >
          {loading ? "Retrying…" : "Retry history"}
        </button>
      </div>
    );
  }
  if (matches.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          border: "1px dashed var(--pw-border)",
          borderRadius: 6,
        }}
      >
        {history.failure ? (
          <div className="callout error" role="alert">
            Couldn&apos;t refresh match history: {history.failure.message}
          </div>
        ) : null}
        <strong style={{ fontSize: 13 }}>No matches recorded yet</strong>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          History fills as inbound emails arrive that match this rule. If you're
          sure mail should be matching, use the Test match panel on the rules
          page to dry-run a few examples.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: 8 }}
          aria-disabled={loading || undefined}
          aria-busy={loading || undefined}
          onClick={retry}
        >
          {loading ? "Refreshing…" : "Refresh history"}
        </button>
      </div>
    );
  }
  return (
    <div>
      {history.failure ? (
        <div className="callout error" role="alert">
          <span>
            Couldn&apos;t refresh match history: {history.failure.message}. The
            last verified history remains visible below.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={loading || undefined}
            aria-busy={loading || undefined}
            onClick={retry}
          >
            {loading ? "Retrying…" : "Retry history"}
          </button>
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <p className="muted" style={{ flex: 1, fontSize: 12, margin: 0 }}>
          Last {matches.length} match{matches.length === 1 ? "" : "es"}, newest
          first. Open a row to see what each action did.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={loading || undefined}
          aria-busy={loading || undefined}
          onClick={retry}
        >
          {loading ? "Refreshing…" : "Refresh history"}
        </button>
      </div>
      <div className="inbound-match-rows" role="list">
        {matches.map((m) => (
          <MatchRow key={m.id} match={m} />
        ))}
      </div>
    </div>
  );
}

/**
 * Single match row: header summary always rendered; click-to-expand
 * reveals the per-action outcomes via the v2 ActionRunsPanel. The
 * previous table layout truncated subjects and gave no debugging
 * affordance; this disclosure pattern matches the v2 audit's
 * "did my webhook actually fire?" loop.
 */
function MatchRow({ match }: { match: InboundRouteMatch }): ReactElement {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="inbound-match-row" role="listitem">
      <button
        type="button"
        className="inbound-match-summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        <time
          className="muted tabular inbound-match-when"
          dateTime={match.matched_at}
        >
          <span>{formatInboundRouteRelative(match.matched_at)}</span>
          <span style={{ display: "block", fontSize: 10 }}>
            {formatInboundRouteAbsolute(match.matched_at)}
          </span>
        </time>
        <span className="mono inbound-match-from">
          <span className="muted">From: </span>
          {match.from_email || "—"}
        </span>
        <span className="mono inbound-match-to">
          <span className="muted">To: </span>
          {match.recipient}
        </span>
        <span className="inbound-match-subject">
          <span className="muted">Subject: </span>
          {match.subject || <span className="muted">—</span>}
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="inbound-match-body">
          <ActionRunsPanel matchID={match.id} open={open} />
        </div>
      ) : null}
    </div>
  );
}

function Chevron({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 100ms ease-out",
        marginRight: 6,
        flex: "none",
      }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
