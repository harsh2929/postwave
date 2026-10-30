// SPDX-License-Identifier: AGPL-3.0-only
//
// The board. One page, six lanes, no graphs.
//
// Server component: fetches the board per request (cookie forwarded, no
// cache) and renders the lanes in fixed order. A non-OK API is a full-page
// error — NEVER an empty board. An empty board reads as green, and a
// dashboard whose failure mode is a confident green is the bug this whole
// thing exists to prevent.
//
// The status strip + freshness dot are read-time enhancements over that same
// data — never a second source of truth. CountUp/motion are pure hydration
// polish: with JS off the real numbers and lanes still render.

import { fetchBoard, formatAge, LANE_ORDER } from "@/lib/board";
import Lane from "@/components/Lane";
import CountUp from "@/components/CountUp";

export const dynamic = "force-dynamic";

const STALE_AFTER_SECONDS = 120;

// A board timestamp up to this far ahead of the server clock is normal jitter;
// beyond it, the two clocks disagree and freshness can't be trusted.
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

export default async function BoardPage() {
  const result = await fetchBoard();

  if (!result.ok) {
    return (
      <main id="main-content" tabIndex={-1} className="fail" role="alert">
        <h1 className="fail__title">BOARD UNAVAILABLE</h1>
        <p className="fail__msg">{result.message}</p>
        <p className="fail__note">
          Unknown is not green. Until the board loads, assume something is on
          fire.
        </p>
      </main>
    );
  }

  const { board } = result;
  // isBoardResponse guarantees all eight lanes are present exactly once, so this
  // is LANE_ORDER-aligned and fully populated — the stats below read straight
  // off it by position instead of re-scanning board.lanes once per stat.
  const lanes = LANE_ORDER.map(
    (name) => board.lanes.find((l) => l.name === name)!,
  );
  const onFire = lanes[0].count;
  const needsYou = lanes[1].count;
  const blocked = lanes[2].count;
  const unwatched = lanes[3].count;
  const clocks = lanes[4].count;
  const automations = lanes[5].count;
  const autoStale = lanes[5].stale ?? 0;
  const green = lanes[7].count;

  // Coverage is the honest headline: every other number on this bar describes
  // what the board CAN see, and this one describes how much of the platform
  // that is. A green board with low coverage is not a healthy platform, it is
  // a quiet instrument, and the difference has to be legible at a glance.
  //
  // It comes from the API (board.coverage), never from counting cards here —
  // the GREEN lane carries IDs rather than cards, so a local count would drop
  // every domain whose only check is passing.
  const { declared: declaredSurfaces, watched: watchedSurfaces } = board.coverage;

  // Freshness is derived at read time. A board timestamp in the FUTURE means
  // the API and this console disagree on the clock; freshness is then
  // meaningless, so say so loudly rather than clamping the age silently to
  // "0s ago" — which would read as freshly green, the exact lie to avoid.
  const nowIso = new Date().toISOString();
  const rawAgeSeconds = Math.round(
    (Date.parse(nowIso) - Date.parse(board.generated_at)) / 1000,
  );
  const skewed = rawAgeSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS;
  const ageSeconds = Math.max(0, rawAgeSeconds);
  const stale = skewed || ageSeconds > STALE_AFTER_SECONDS;

  const stats: {
    n: number;
    label: string;
    sub: string;
    variant: string;
    hot?: boolean;
  }[] = [
    { n: onFire, label: "On fire", sub: onFire > 0 ? "act now" : "clear", variant: "red", hot: onFire > 0 },
    { n: needsYou, label: "Needs you", sub: needsYou > 0 ? "review" : "clear", variant: "amber" },
    {
      n: blocked,
      label: "Blocked",
      sub: blocked > 0 ? "not an engineering fix" : "none",
      variant: blocked > 0 ? "blocked" : "muted",
    },
    {
      n: unwatched,
      label: "Unwatched",
      sub: unwatched > 0 ? "no signal at all" : "full coverage",
      variant: unwatched > 0 ? "blocked" : "green",
      // An unwatched surface is not an emergency, but it IS the reason the
      // rest of this bar might be wrong. Flag it hot so it cannot be skimmed
      // past on the way to the reassuring green number.
      hot: unwatched > 0,
    },
    { n: clocks, label: "Clocks due", sub: clocks > 0 ? "time-based" : "nothing due", variant: "info" },
    {
      n: autoStale,
      label: "Automations stale",
      // "all alive" over zero heartbeats is a lie by arithmetic: nothing is
      // stale because nothing reports. Say which of the two it is.
      sub:
        automations === 0
          ? "nothing reports here"
          : autoStale > 0
            ? "not firing"
            : `all ${automations} alive`,
      variant: automations === 0 ? "blocked" : autoStale > 0 ? "red" : "muted",
      hot: automations === 0,
    },
    { n: green, label: "Green", sub: "passing", variant: "green" },
  ];

  return (
    <main id="main-content" tabIndex={-1} className="page">
      <header className="page__head">
        <h1 className="page__title">Moosewave Ops</h1>
        <div className="page__meta">
          <span
            className={`freshness${stale ? " freshness--stale" : ""}`}
            title={`generated ${board.generated_at} · server now ${nowIso}`}
          >
            <span className="freshness__dot" aria-hidden="true" />
            {skewed ? (
              <>clock skew — board time is ahead of this server; freshness unreliable</>
            ) : (
              <>
                {stale ? "stale — " : ""}generated{" "}
                <time dateTime={board.generated_at}>
                  {formatAge(board.generated_at, nowIso)} ago
                </time>
              </>
            )}
          </span>
        </div>
      </header>

      <p className="coverage" role="status">
        {unwatched === 0 ? (
          <>
            All <strong>{declaredSurfaces}</strong> declared surfaces have a check
            that can report.
          </>
        ) : (
          <>
            <strong>
              {watchedSurfaces} of {declaredSurfaces}
            </strong>{" "}
            declared surfaces have a check that can report.{" "}
            <strong>{unwatched}</strong> {unwatched === 1 ? "has" : "have"} none —
            everything below is silent about {unwatched === 1 ? "it" : "them"}.
          </>
        )}
      </p>

      <section className="statbar" aria-label="Board health summary">
        {stats.map((s) => (
          <div
            key={s.label}
            className={`stat stat--${s.variant}${s.hot ? " stat--hot" : ""}`}
          >
            <CountUp className="stat__num" value={s.n} />
            <span className="stat__label">{s.label}</span>
            <span className="stat__sub">{s.sub}</span>
          </div>
        ))}
      </section>

      <div className="stagger" style={{ display: "grid", gap: "0.9rem" }}>
        {lanes.map((lane, i) => (
          <Lane
            key={lane.name}
            lane={lane}
            generatedAt={board.generated_at}
            index={i}
          />
        ))}
      </div>
    </main>
  );
}
