/**
 * ConversationRow — one row in the SMS inbox list.
 * Refined SMS Inbox PR 1: extracted from SMSInbox.tsx so the page
 * focuses on data flow and the row owns its own presentation +
 * subscriber-vs-unknown affordance.
 *
 * Visual rules:
 *   - Unread → bold preview + accent-tinted unread badge with count.
 *   - Last direction: ↗ for outbound, ↘ for inbound (inbound uses
 *     the info colour, not the brand teal, so it doesn't collide
 *     with the polish-PR semantic split).
 *   - Unknown subscriber → italic "unknown subscriber" label rather
 *     than just the muted email row — makes it obvious at a glance
 *     when triaging the Unknown filter.
 */

import type { ReactElement } from "react";

import type { SMSConversationSummary } from "../../lib/api-client";

interface Props {
  conversation: SMSConversationSummary;
  selected: boolean;
  onClick: () => void;
  /** Optional hover affordances. Each is hidden when omitted. The
   *  parent owns the API call + list refresh so the row is purely
   *  presentational. */
  onArchive?: () => void;
  onSnooze?: () => void;
  onMarkRead?: () => void;
}

function fmtRelative(s: string | undefined): string {
  if (!s) return "—";
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return s;
  const diff = Math.round((Date.now() - t) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function fmtPhone(p: string): string {
  if (p.startsWith("+1") && p.length === 12) {
    return `+1 (${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}`;
  }
  return p;
}

export function ConversationRow({
  conversation: c,
  selected,
  onClick,
  onArchive,
  onSnooze,
  onMarkRead,
}: Props): ReactElement {
  const identityAmbiguous = (
    c as SMSConversationSummary & { identityAmbiguous?: boolean }
  ).identityAmbiguous;
  const previewOmitted = c.lastMessagePreviewOmittedReason !== undefined;
  const hasSubscriber = !identityAmbiguous && !!c.subscriberEmail;
  const cls = [
    "sms-inbox-row",
    selected ? "is-selected" : "",
    c.unreadCount > 0 ? "is-unread" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const action = (
    label: string,
    shortLabel: string,
    handler: (() => void) | undefined,
    danger?: boolean,
  ): ReactElement | null => {
    if (!handler) return null;
    return (
      <button
        type="button"
        aria-label={label}
        className={`sms-row-action${danger ? " danger" : ""}`}
        onClick={handler}
      >
        {shortLabel}
      </button>
    );
  };

  const showActions = !!(onArchive || onSnooze || onMarkRead);

  return (
    <article className={cls} aria-label={`Conversation with ${c.phoneE164}`}>
      <button
        type="button"
        className="sms-inbox-row-open"
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
      >
        <span className="sms-inbox-row-head">
          <span className="sms-inbox-row-phone">{fmtPhone(c.phoneE164)}</span>
          <span className="muted small tabular">
            {fmtRelative(c.lastMessageAt)}
          </span>
        </span>
        <span className="sms-inbox-row-preview">
          <span
            className={
              c.lastDirection === "outbound" ? "muted" : "sms-direction-in"
            }
            aria-hidden="true"
          >
            {c.lastDirection === "outbound" ? "↗" : "↘"}{" "}
          </span>
          <span className="visually-hidden">
            {c.lastDirection === "outbound" ? "Outbound: " : "Inbound: "}
          </span>
          {previewOmitted ? (
            <span className="sms-message-preview-unavailable">
              {c.lastMessagePreviewOmittedReason === "legacy_body_unavailable"
                ? "Legacy message preview unavailable"
                : "Message body unavailable · exceeded inbox evidence limit"}
            </span>
          ) : c.lastMessagePreview ? (
            <bdi className="sms-message-text" dir="auto">
              {c.lastMessagePreview}
            </bdi>
          ) : (
            <span className="muted">(no body)</span>
          )}
        </span>
        <span className="sms-inbox-row-meta">
          {identityAmbiguous ? (
            <span className="muted small sms-row-ambiguous">
              Multiple linked identities
            </span>
          ) : hasSubscriber ? (
            <span className="muted small">{c.subscriberEmail}</span>
          ) : (
            <span className="muted small sms-row-unknown">
              Unknown subscriber
            </span>
          )}
          {c.unreadCount > 0 ? (
            <span
              className="sms-row-unread-badge tabular"
              aria-label={`${c.unreadCount} unread message${c.unreadCount === 1 ? "" : "s"}`}
            >
              {c.unreadCount}
            </span>
          ) : null}
        </span>
      </button>
      {showActions ? (
        <div className="sms-row-actions" aria-label="Conversation shortcuts">
          {c.unreadCount > 0
            ? action("Mark conversation read", "Read", onMarkRead)
            : null}
          {action("Snooze conversation for 1 hour", "Snooze", onSnooze)}
          {action("Archive conversation", "Archive", onArchive, true)}
        </div>
      ) : null}
    </article>
  );
}
