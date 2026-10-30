/**
 * ThreadHeader — sticky header at the top of an open SMS thread.
 * Refined SMS Inbox PR 1.
 *
 * Shows the formatted phone, the consent posture badge (opted_in /
 * opted_out / pending / unknown), and a subscriber context strip
 * with email, list count, opt-in source, and first-seen date.
 *
 * Why this matters: the operator about to reply needs to know in one
 * glance whether the person is even subscribed. Replying to a STOP
 * sender (opted_out) is a compliance problem; the badge makes that
 * visible before they type.
 */

import type { ReactElement } from "react";

import type { SMSConversationContext } from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";

interface Props {
  phone: string;
  context: SMSConversationContext | null;
  loading: boolean;
}

function fmtPhone(p: string): string {
  if (p.startsWith("+1") && p.length === 12) {
    return `+1 (${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}`;
  }
  return p;
}

function consentBadge(status: SMSConversationContext["consentStatus"]): {
  className: string;
  description: string;
  label: string;
} {
  switch (status) {
    case "opted_in":
      return {
        className: "is-opted-in",
        label: "Opt-in recorded",
        description:
          "An aggregate opt-in record exists. Only an exact eligible list shown below can authorize a send.",
      };
    case "opted_out":
      return {
        className: "is-opted-out",
        label: "Consent revoked",
        description:
          "The loaded consent record is revoked. Reply is structurally locked.",
      };
    case "pending":
      return {
        className: "is-pending",
        label: "Consent pending",
        description:
          "This pending record does not establish an eligible list or authorize a send.",
      };
    default:
      return {
        className: "is-unknown",
        label: "No verified consent",
        description:
          "No verified eligible SMS list is recorded in the loaded context. Reply is locked.",
      };
  }
}

export function ThreadHeader({ phone, context, loading }: Props): ReactElement {
  const status = context?.consentStatus ?? "none";
  const eligibleLists = context?.eligibleLists ?? [];
  const suppressed = context?.suppressed === true;
  const badge = suppressed
    ? {
        className: "is-opted-out",
        label: "System suppressed",
        description:
          "An authoritative system suppression is recorded. Reply and retry are locked.",
      }
    : context?.identityAmbiguous
      ? {
          className: "is-pending",
          label: "Identity conflict",
          description:
            "Multiple subscriber identities are linked to this phone. Reply is structurally locked.",
        }
      : context?.consentMixed
        ? {
            className: "is-pending",
            label: "Consent conflict",
            description:
              "Conflicting consent records are loaded. Reply is structurally locked.",
          }
        : context &&
            context.consentStatus !== "opted_out" &&
            !context.consentEvidenceSufficient
          ? {
              className: "is-unknown",
              label: "Evidence incomplete",
              description:
                "Complete timestamped eligible-list evidence is not available. Reply is structurally locked.",
            }
          : consentBadge(status);

  return (
    <div className="sms-thread-head">
      <div className="sms-thread-head-top">
        <h3 className="sms-thread-phone">{fmtPhone(phone)}</h3>
        <span className={`sms-consent-badge ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      <div className="muted small sms-consent-guidance">
        {badge.description}
      </div>
      <div className="sms-thread-context">
        {loading ? (
          <span className="muted small" role="status" aria-live="polite">
            Loading subscriber context…
          </span>
        ) : context ? (
          <>
            {context.identityAmbiguous ? (
              <span className="sms-context-item muted small">
                Multiple linked identities · no subscriber was selected
              </span>
            ) : context.subscriberEmail ? (
              <span className="sms-context-item">
                <span className="muted small">Subscriber:</span>{" "}
                <bdi>{context.subscriberEmail}</bdi>
              </span>
            ) : (
              <span className="sms-context-item muted small">
                Not linked to a subscriber
              </span>
            )}
            {eligibleLists.length > 0 ? (
              <ul
                className="sms-context-eligible-lists"
                aria-label="Eligible SMS consent lists"
              >
                {eligibleLists.map((list) => (
                  <li key={list.id}>
                    <strong>
                      <bdi>{list.name}</bdi>
                    </strong>
                    {list.description ? (
                      <span className="muted small">
                        <bdi>{list.description}</bdi>
                      </span>
                    ) : null}
                    <span className="muted small">
                      {list.consentSource ? (
                        <>
                          Source: <bdi>{list.consentSource}</bdi>
                        </>
                      ) : (
                        "Source not reported"
                      )}
                      {list.consentAt
                        ? ` · recorded ${fmtDate(list.consentAt)}`
                        : " · time not reported"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="sms-context-item muted small">
                No exact eligible SMS list in this loaded context
              </span>
            )}
            {suppressed ? (
              <span className="sms-context-item muted small">
                Suppression category:{" "}
                <bdi>{context.suppressionReason ?? "system"}</bdi>
              </span>
            ) : null}
            {!context.replyDispatchAvailable ? (
              <span className="sms-context-item muted small">
                Live dispatch unavailable · no provider request can start
              </span>
            ) : null}
            {context.totalMessages > 0 ? (
              <span className="sms-context-item muted small tabular">
                {context.totalMessages.toLocaleString()} retained message record
                {context.totalMessages === 1 ? "" : "s"}
                {context.firstSeenAt
                  ? ` · first seen ${fmtDate(context.firstSeenAt)}`
                  : ""}
              </span>
            ) : null}
          </>
        ) : (
          <span className="sms-context-item muted small">
            No subscriber context found for this phone.
          </span>
        )}
      </div>
      <p className="muted small sms-consent-evidence-boundary">
        This is loaded consent evidence, not a complete authority ledger.
        Potential free-form revocations may require separate review; the send
        gate remains authoritative.
      </p>
    </div>
  );
}
