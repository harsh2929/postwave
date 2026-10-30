/**
 * StatusChips — lifecycle filter chips (Active / Snoozed / Archived /
 * All) above the inbox list. Refined SMS Inbox PR 2.
 *
 * Each chip shows a stable server-fed badge count so the operator
 * knows the size of each bucket without clicking through. Active is
 * the default because that's the operator-zero workflow — snoozed +
 * archived are out of sight unless explicitly requested.
 */

import type { ReactElement } from "react";

import type { SMSConversationStatus } from "../../lib/api-client";

interface Props {
  status: SMSConversationStatus;
  totals: { active: number; snoozed: number; archived: number; any: number };
  onChange: (s: SMSConversationStatus) => void;
}

const CHIPS: Array<{
  id: SMSConversationStatus;
  label: string;
  key: keyof Props["totals"];
}> = [
  { id: "active", label: "Active", key: "active" },
  { id: "snoozed", label: "Snoozed", key: "snoozed" },
  { id: "archived", label: "Archived", key: "archived" },
  { id: "any", label: "All", key: "any" },
];

export function StatusChips({ status, totals, onChange }: Props): ReactElement {
  return (
    <div
      className="chips sms-status-chips"
      role="group"
      aria-label="Conversation lifecycle"
    >
      {CHIPS.map((c) => {
        const n = totals[c.key];
        return (
          <button
            key={c.id}
            type="button"
            className={`chip${status === c.id ? " is-active" : ""}`}
            onClick={() => onChange(c.id)}
            aria-pressed={status === c.id}
          >
            {c.label}
            {n > 0 ? <span className="sms-chip-count tabular">{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
