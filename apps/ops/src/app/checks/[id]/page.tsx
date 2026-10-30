// SPDX-License-Identifier: AGPL-3.0-only
//
// One check, and what it has actually been doing. Reached from any board row.

import Link from "next/link";

import { formatAge } from "@/lib/board";
import { fetchCheckDetail, verdict } from "@/lib/checkDetail";

export const dynamic = "force-dynamic";

const STATUS_TAG: Record<string, string> = {
  red: "red", stale: "red", due: "amber", warn: "amber", ok: "green", blocked: "blocked",
};

const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");

export default async function CheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await fetchCheckDetail(id);

  if (!result.ok) {
    return (
      <main id="main-content" tabIndex={-1} className="fail" role="alert">
        <h1 className="fail__title">CHECK UNAVAILABLE</h1>
        <p className="fail__msg">{result.message}</p>
        <p className="fail__note">
          <Link href="/">Back to the board</Link>
        </p>
      </main>
    );
  }

  const { detail } = result;
  const { card } = detail;
  const now = new Date().toISOString();

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">{card.title || card.id}</h1>
        <span className={`tag tag--${STATUS_TAG[card.status] ?? "muted"}`}>{card.status}</span>
        <div className="page__meta">
          <Link href="/">← board</Link>
        </div>
      </header>

      <p className="coverage" role="status">{verdict(detail)}</p>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>What this is</h2>
        <ul className="checks">
          <li className="check">
            <code className="check__id">{card.id}</code>
            <span className="check__why">{card.why}</span>
            {card.detail ? <span className="check__detail">{card.detail}</span> : null}
            <span className="check__owner">{card.owner ?? "unowned"}</span>
          </li>
          <li className="check">
            <strong className="check__title">What to do</strong>
            <span className="check__detail">{card.remediation}</span>
            {card.runbook ? (
              <a className="check__runbook" href={card.runbook}>runbook ↗</a>
            ) : null}
          </li>
          {card.blocked ? (
            <li className="check check--unwatched">
              <span className="tag tag--blocked">blocked</span>
              <span className="check__blocked">
                {card.blocked.reason} — only {card.blocked.owner} can clear this
              </span>
            </li>
          ) : null}
        </ul>
      </section>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>
          Transitions <span className="page__count">({detail.history.length})</span>
        </h2>
        {detail.history.length === 0 ? (
          <p role="status" className="note note--warn">
            Nothing recorded. Transitions are only written when the status
            CHANGES, so this means the check has never changed — not that it has
            never run.
          </p>
        ) : (
          <div className="scroll-x panel">
            <table style={{ minWidth: "40rem", fontSize: "0.9rem" }}>
              <caption>Status transitions, newest first.</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {detail.history.map((entry) => (
                  <tr key={`${entry.at}-${entry.to}`}>
                    <th scope="row" style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                      <time dateTime={entry.at}>{when(entry.at)}</time>{" "}
                      <span className="check__owner">{formatAge(entry.at, now)} ago</span>
                    </th>
                    <td><span className="check__id">{entry.from}</span></td>
                    <td>
                      <span className={`tag tag--${STATUS_TAG[entry.to] ?? "muted"}`}>{entry.to}</span>
                    </td>
                    <td style={{ color: "var(--text-2)" }}>{entry.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail.ticks ? (
        <section style={{ margin: "1.5rem 0" }}>
          <h2>
            Recorded ticks <span className="page__count">({detail.ticks.length})</span>
          </h2>
          {detail.ticks.length === 0 ? (
            <p role="status" className="note note--warn">
              This chore has never been recorded as done.
            </p>
          ) : (
            <ul className="checks">
              {detail.ticks.map((tick) => (
                <li className="check" key={`${tick.ticked_at}-${tick.operator}`}>
                  <strong className="check__title">
                    <time dateTime={tick.ticked_at}>{when(tick.ticked_at)}</time>
                  </strong>
                  <span className="check__detail">{tick.note}</span>
                  <span className="check__owner">{tick.operator}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </main>
  );
}
