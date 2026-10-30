/**
 * DaySeparator — small horizontal divider with the day label
 * (e.g. "Today", "Yesterday", "Tue, May 21") between message bubbles
 * from different calendar days. Refined SMS Inbox PR 1.
 *
 * iMessage / WhatsApp / Slack all use this — without it, scrolling
 * a long thread loses the temporal anchor and the operator can't
 * tell whether a reply was "ten minutes after" or "ten days after".
 */

import type { ReactElement } from "react";

interface Props {
  date: Date;
}

function labelForDay(d: Date): string {
  const now = new Date();
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(now) - startOfDay(d)) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function DaySeparator({ date }: Props): ReactElement {
  return (
    <div className="sms-day-separator" role="separator">
      <span className="sms-day-separator-label">{labelForDay(date)}</span>
    </div>
  );
}
