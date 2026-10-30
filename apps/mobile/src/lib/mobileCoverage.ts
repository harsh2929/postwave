/**
 * lib/mobileCoverage.ts — the verdict vocabulary the coverage ledgers speak.
 *
 * Split out of `desktopOnlyCapabilities.ts` so that the tables which use it —
 * the desktop-anchored one, the web-anchored one, and the SDK-anchored
 * `capabilityCoverage` — can each be a file of its own without one of them
 * owning the type the others import. Nothing but the type lives here, so it
 * stays import-free and node-testable like every module that reads it.
 */

/**
 * How a desktop sidebar section is reachable on this phone.
 *
 *  - `route`  — mobile has a destination of its own; the value is the
 *               `MobileSecondaryRoute.key`, or a bottom-tab slug.
 *  - `inside` — mobile folds it into another screen as a panel/section. The
 *               value is the HOST screen's route key — an identifier, not
 *               prose, so the test can check the host screen actually exists
 *               and so this table never becomes a second place copy lives.
 *               The comment beside each says why the fold is the right shape
 *               rather than an omission.
 *  - `absent` — mobile does not have it at all. These are the rows the closing
 *               block renders.
 *  - `api_only` — the capability has NO human UI on any surface and is not
 *               meant to: it is reached through the SDK or the raw API. This is
 *               a different claim from `absent`, and conflating the two would
 *               be dishonest in both directions — it would list a partner API
 *               as a mobile gap, and it would let a genuine desktop-only screen
 *               hide behind "developers use the API".
 */
export type MobileCoverage =
  | { kind: "route"; mobileKey: string }
  | { kind: "inside"; hostKey: string }
  | { kind: "absent" }
  | { kind: "api_only"; reason: string };
