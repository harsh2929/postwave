// SPDX-License-Identifier: AGPL-3.0-only
//
// Lane — one section of the board. Card lanes list CheckRows; AUTOMATIONS is
// an alive/stale summary plus the stale IDs; GREEN is a collapsed count
// (native <details>, no client JS). The stagger index is passed as a CSS
// custom property; the per-lane accent is chosen in globals.css by data-lane,
// so lane colours live in the design layer and cannot drift from it.

import type { CSSProperties } from "react";

import type { Lane as LaneData } from "@/lib/board";
import CheckRow from "@/components/CheckRow";

export default function Lane({
  lane,
  generatedAt,
  index = 0,
}: {
  lane: LaneData;
  generatedAt: string;
  index?: number;
}) {
  return (
    <section
      className="lane"
      data-lane={lane.name}
      style={{ "--i": index } as CSSProperties}
      aria-label={`${lane.name} — ${lane.count}`}
    >
      <header className="lane__head">
        <h2 className="lane__title">{lane.name}</h2>
        <span className="lane__count">{lane.count}</span>
      </header>

      {lane.name === "AUTOMATIONS" ? (
        <div className="lane__body">
          <span style={{ color: "var(--green-ink)" }}>{lane.alive ?? 0} alive</span>
          {" · "}
          <span className={(lane.stale ?? 0) > 0 ? "check__hot" : "check__snooze"}>
            {lane.stale ?? 0} stale
          </span>
          {lane.stale_ids && lane.stale_ids.length > 0 ? (
            <div className="lane__ids">
              {lane.stale_ids.map((id) => (
                <code key={id} style={{ color: "var(--red-ink)" }}>
                  {id}
                </code>
              ))}
            </div>
          ) : null}
        </div>
      ) : lane.name === "UNWATCHED" ? (
        <div className="lane__body">
          {lane.count === 0 ? (
            <span className="lane__empty">
              every declared surface has a check that can report
            </span>
          ) : (
            <ul className="checks">
              {(lane.domains ?? []).map((d) => (
                <li className="check check--unwatched" key={d.id}>
                  <span className="tag tag--unwatched">
                    {d.reason === "all_checks_blocked" ? "blocked" : "no check"}
                  </span>
                  <strong className="check__title">{d.label}</strong>
                  <code className="check__id">{d.id}</code>
                  <span className="check__why">{d.why}</span>
                  {d.blocked_by && d.blocked_by.length > 0 ? (
                    <span className="check__detail">
                      blocked by: {d.blocked_by.join("; ")}
                    </span>
                  ) : null}
                  <span className="check__owner">{d.owner}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : lane.name === "GREEN" ? (
        <div className="lane__body">
          {lane.count > 0 ? (
            <details>
              <summary>
                {lane.count} green check{lane.count === 1 ? "" : "s"}
              </summary>
              <div className="lane__ids">
                {(lane.ids ?? []).map((id) => (
                  <code key={id} style={{ color: "var(--text-4)" }}>
                    {id}
                  </code>
                ))}
              </div>
            </details>
          ) : (
            <span className="lane__empty">nothing green — see above</span>
          )}
        </div>
      ) : lane.cards && lane.cards.length > 0 ? (
        <ul className="checks">
          {lane.cards.map((card) => (
            <CheckRow key={card.id} card={card} generatedAt={generatedAt} />
          ))}
        </ul>
      ) : (
        <div className="lane__empty">empty</div>
      )}
    </section>
  );
}
