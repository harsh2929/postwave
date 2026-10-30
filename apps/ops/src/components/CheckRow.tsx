// SPDX-License-Identifier: AGPL-3.0-only
//
// CheckRow — one check on the board: [status] title · id · why · detail · age
// · [runbook ↗] [action] [snooze].
//
// Still a server component. The only interactive part — CheckActions — is the
// leaf, so the board itself keeps rendering with no client JS at all: a broken
// bundle costs you the buttons, never the truth. The status is a named tag
// (never colour alone) so it stays legible to everyone.

import Link from "next/link";

import type { Card } from "@/lib/board";
import { formatAge } from "@/lib/board";
import CheckActions from "@/components/CheckActions";

const STATUS_TAG: Record<string, string> = {
  red: "red",
  stale: "red",
  due: "amber",
  warn: "amber",
  ok: "green",
  // Blocked gets its own tone, not red and not muted. Red would put a purchase
  // order in the same visual bucket as an outage; muted would let it fade into
  // the background, which is how a launch blocker becomes a launch surprise.
  blocked: "blocked",
};

export default function CheckRow({
  card,
  generatedAt,
}: {
  card: Card;
  generatedAt: string;
}) {
  const tag = STATUS_TAG[card.status] ?? "muted";
  const isRed = card.status === "red" || card.status === "stale";

  return (
    <li className="check">
      <span className={`tag tag--${tag}`}>{card.status}</span>

      <strong className="check__title">
        <Link href={`/checks/${encodeURIComponent(card.id)}`} className="check__link">
          {card.title || card.id}
        </Link>
      </strong>
      <code className="check__id">{card.id}</code>

      <span className="check__why">{card.why}</span>

      {card.detail ? <span className="check__detail">{card.detail}</span> : null}

      {card.blocked ? (
        <span className="check__blocked">
          blocked: {card.blocked.reason} — only {card.blocked.owner} can clear this
          {card.blocked.tracking ? (
            <>
              {" "}
              <a className="check__runbook" href={card.blocked.tracking}>
                tracking ↗
              </a>
            </>
          ) : null}
        </span>
      ) : null}

      {isRed && card.first_red_at ? (
        <span className="check__hot">
          red {formatAge(card.first_red_at, generatedAt)}
        </span>
      ) : null}

      {card.due_at ? (
        <span className="check__due">
          {new Date(card.due_at).getTime() <= new Date(generatedAt).getTime()
            ? `due ${formatAge(card.due_at, generatedAt)} ago`
            : `due in ${formatAge(card.due_at, generatedAt)}`}
        </span>
      ) : null}

      {card.acked_until ? (
        <span className="check__snooze">
          snoozed until{" "}
          <time dateTime={card.acked_until}>
            {new Date(card.acked_until).toISOString().slice(0, 16).replace("T", " ")} UTC
          </time>
          {card.ack_reason ? ` — ${card.ack_reason}` : ""}
        </span>
      ) : null}

      {card.owner ? <span className="check__owner">{card.owner}</span> : null}

      <span className="check__spacer">
        {card.runbook ? (
          <a className="check__runbook" href={card.runbook}>
            runbook ↗
          </a>
        ) : null}
        <CheckActions checkId={card.id} action={card.action} />
      </span>
    </li>
  );
}
