/**
 * HygienePlaybooks — expandable educational cards.
 *
 * Three playbooks ship by default:
 *   - Sunset flow (re-engage or suppress dormant subscribers)
 *   - Apple MPP guidance (open rate inflation + how to compensate)
 *   - Bounce-class playbook (which classes deserve which response)
 *
 * Each card collapses to a one-line summary and expands inline. Pure
 * markup — no API calls. Content is canon based on the gap analysis
 * (GAP-LS-140 references Litmus / EmailGeeks / Klaviyo docs).
 */

import { useState, type ReactElement } from "react";

interface Playbook {
  id: string;
  title: string;
  summary: string;
  body: ReactElement;
}

const PLAYBOOKS: Playbook[] = [
  {
    id: "sunset",
    title: "Sunset flow",
    summary:
      "Re-engage or suppress subscribers who haven't opened in 90+ days.",
    body: (
      <>
        <p>
          Mailbox providers (Gmail / Yahoo) penalize senders that keep mailing
          dormant addresses. A sunset flow protects your reputation:
        </p>
        <ol style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>
            <strong>Identify</strong> subscribers with no engagement in ≥90 days
            (open + click + reply + form-submit).
          </li>
          <li>
            <strong>Win-back</strong> series: 2–3 emails over 14 days with a
            single, friction-free CTA ("Still want these?").
          </li>
          <li>
            <strong>Suppress</strong> non-responders automatically — move them
            to a separate list and stop sending broadcasts. They are still
            reachable via 1:1 (e.g. account / transactional).
          </li>
          <li>
            <strong>Measure</strong> the suppression cohort's bounce + complaint
            deltas over the following 30 days.
          </li>
        </ol>
      </>
    ),
  },
  {
    id: "mpp",
    title: "Apple Mail Privacy Protection (MPP)",
    summary:
      "Open rates from Apple Mail are inflated — here's what to use instead.",
    body: (
      <>
        <p>
          MPP pre-fetches images server-side when the recipient opens Apple Mail
          with privacy protection enabled (~40% of opens in most B2C audiences).
          Treat opens from Apple as inflated.
        </p>
        <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>
            <strong>Use clicks</strong> as the primary engagement signal for
            segmentation, sunset flows, and send-time optimization.
          </li>
          <li>
            <strong>Filter</strong> Apple-MPP opens from your engagement-based
            segments — Moosewave does this automatically when "Exclude
            pre-fetched opens" is enabled in Send-time.
          </li>
          <li>
            <strong>Compare cohorts</strong>: Apple vs Gmail open rates should
            track within ~5pp of each other once MPP is corrected for.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "bounces",
    title: "Bounce-class playbook",
    summary:
      "Hard / soft / block / mailbox_full each need a different response.",
    body: (
      <>
        <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>
            <strong>Hard</strong>: address is invalid. Suppress immediately and
            never retry.
          </li>
          <li>
            <strong>Soft</strong>: temporary failure. Retry with backoff up to
            72h; after 5 soft bounces in 30 days, suppress.
          </li>
          <li>
            <strong>Block</strong>: receiver rejected for reputation / content
            reasons. Pause sending to that domain and check blocklists. Don't
            keep retrying — it makes things worse.
          </li>
          <li>
            <strong>Mailbox full</strong>: retry once per day for 7 days, then
            suppress.
          </li>
          <li>
            <strong>DNS</strong>: the recipient's domain has no valid MX
            records. Suppress.
          </li>
          <li>
            <strong>Content</strong>: receiver flagged the message body. Review
            template, then re-send via a different identity.
          </li>
        </ul>
      </>
    ),
  },
];

export function HygienePlaybooks(): ReactElement {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>Hygiene playbooks</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Operator-grade recipes for keeping reputation healthy
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {PLAYBOOKS.map((p) => {
          const isOpen = open === p.id;
          return (
            <div
              key={p.id}
              style={{
                border: "1px solid var(--pw-border)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : p.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: 0,
                  padding: "10px 12px",
                  cursor: "pointer",
                  color: "inherit",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>{p.title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {p.summary}
                  </div>
                </div>
                <span
                  aria-hidden
                  style={{
                    fontSize: 16,
                    transform: isOpen ? "rotate(90deg)" : "none",
                    transition: "transform 120ms",
                    opacity: 0.6,
                  }}
                >
                  ›
                </span>
              </button>
              {isOpen ? (
                <div
                  style={{
                    padding: "8px 16px 14px",
                    borderTop: "1px solid var(--pw-border)",
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  {p.body}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
