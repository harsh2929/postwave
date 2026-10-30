# The Moose Motion System

**Status:** Design proposal
**Date:** 2026-07-27
**Scope:** marketing site · web app · desktop · mobile
**Author:** design/engineering

---

## 0. The thesis, and the tension it resolves

Moosewave's positioning is *"deliverability you can prove."* It is aimed at people
whose job depends on email working, and its whole credibility rests on being
rigorous rather than charming. A cute animated mascot pulls in exactly the
opposite direction.

Mailchimp gets away with Freddie because *approachable* is genuinely their
positioning — they sell to small businesses who find email marketing
intimidating. That is not our audience and not our promise.

So the moose has to earn its place a different way:

> **Every moose animation must carry information a user needs.**
> If it is purely decorative, it does not ship.

That single rule is what separates a system from a gimmick. The antler loader is
not the mascot doing a trick — it is a progress indicator that happens to be the
brand mark. Snow on the moose's back is not seasonal decoration — it is a
staleness gauge you can read at a glance. Under this rule, "moose everywhere"
does not mean the moose is *doing* something everywhere. It means the moose is
the shape our existing functional feedback takes.

Everything below follows from that.

### The corollary nobody likes

The rule cuts both ways. It rules out most of the fun ideas, and it rules out
the moose entirely in the places where a mascot is most tempting and most
damaging (§4). Hold the line there; that is where the credibility is won.

---

## 1. Why the antlers are the right progress track

Progress indicators need three properties: a legible start, a legible end, and a
monotonic path between them that the eye can read without counting. Palmate
moose antlers have all three by accident of anatomy.

- They **grow outward from the head**, so "empty → full" has a natural direction
  that needs no explanation.
- They are **bilaterally symmetric**, so a value can be shown twice, mirrored,
  which reads as one quantity rather than two.
- They are **the widest part of the silhouette**, so the state is readable at
  the smallest sizes we render — a favicon, a tray icon, a table row.
- They are **already the brand**. We are not adding an element; we are animating
  the one we have.

A spinner communicates only "something is happening." Antlers can communicate
*how much* has happened, which is strictly more useful and costs nothing extra.

### Determinate and indeterminate must look different

This is the part most products get wrong, and it matters more than it sounds.

| | Behaviour | Meaning |
| --- | --- | --- |
| **Indeterminate** | Draws 0 → 100 → 0, ping-pong, never resting full | "Working. Duration unknown." |
| **Determinate** | Fills monotonically to the true percentage and stays | "N% complete." |

An indeterminate indicator that *looks* like a progress bar is a lie: it implies
knowledge of remaining time that we do not have. Making the two visually
distinct — oscillating versus monotonic — is an honesty requirement, not a
stylistic choice. It is also the same discipline as the rest of the product:
`/analytics` tells users that open rate is directional rather than authoritative
for exactly the same reason.

**Never convert one into the other mid-operation.** If a determinate operation
loses its progress source, freeze the antlers and switch the accompanying text —
do not silently start oscillating, which reads as regression.

---

## 2. State vocabulary

The complete set. Anything not on this list does not get a moose.

| State | Moose behaviour | Carries | Tier |
| --- | --- | --- | --- |
| **Idle** | Static mark | Brand only | — |
| **Loading, unknown duration** | Antlers ping-pong 0↔100 | "Working" | 1 |
| **Loading, known progress** | Antlers fill to N% | "N% done" | 1 |
| **Complete** | Antlers reach full, hold 400ms, settle to idle | "Done" | 1 |
| **Stale data** | Snow accumulates on back and antler tops | Age of the view | 2 |
| **Refresh** | Shake — damped rotation, snow flies off | "Refreshing now" | 2 |
| **Pull-to-refresh (mobile)** | Antlers draw with finger travel | Pull distance vs threshold | 2 |
| **Offline** | Desaturated + snow frozen at current level | "Not syncing" | 2 |
| **Empty state** | Full-body moose, standing, looking off-frame | "Nothing here yet" | 3 |
| **Milestone** | Single ear flick + antler shimmer, once | Rare achievement | 3 |

### What the moose never does

No sad moose. No apologetic moose. No moose reacting to failure. The moose can
**work**, **rest**, and — rarely — **acknowledge**. It never commiserates.

A mascot that looks sad during an outage is infuriating to someone whose
campaign is burning, because it performs an emotion the software cannot feel
while doing nothing to help. Errors get plain typography and a clear next
action. That is not a missing feature; it is the feature.

---

## 3. Snow: a staleness gauge, not weather

The idea worth building is not "snow is cute." It is that **snow is a duration
you can read without reading**.

Every data surface in the product has an age. Today that age is a timestamp in
small grey text — precise, and almost never read. Snow makes it ambient: you
glance at the moose and know roughly how stale the view is, and a shake clears
it. This maps directly onto the ops console's staleness-at-read-time invariant,
which already says a view must be able to tell you how old it is.

### Accumulation model

Linear accumulation looks mechanical and spends its whole range on the boring
part. Use a logarithmic curve so the first minute is visible and the tail
flattens:

```
snowLevel(ageMs) = clamp(log₁₀(1 + ageMs / FRESH_MS) / log₁₀(1 + STALE_MS / FRESH_MS), 0, 1)

FRESH_MS = 30_000    // nothing visible below this
STALE_MS = 900_000   // fully capped at 15 minutes
```

Rendered as a growing white cap on the cranium and the top edge of each antler
palm, `snowLevel` driving both height and opacity. It caps rather than growing
forever — an unbounded gauge stops being readable, and "very stale" and
"extremely stale" are the same actionable state.

### The rule that keeps it honest

**Snow is an affordance, never the source of truth.** The exact timestamp stays
in the DOM and in the accessible name. Snow tells you *roughly*; the tooltip
tells you *exactly*. We never replace data with decoration — that would be the
same mistake as treating a product mock's numbers as real, which we already
refuse to do on the marketing site.

### The shake

A damped rotational oscillation, the way an animal actually sheds water:

```
rotate: ±6° → ±4° → ±2.5° → ±1° → 0
duration: 620ms
easing: motion.easing.standard
snow particles: detach at t=120ms, fall with gravity + slight lateral drift, fade at 70% travel
```

Rotation only — never translation. A translating element under a cursor or
finger reads as a UI bug rather than a character.

---

## 4. Where the moose must not appear

Non-negotiable. These are the surfaces where a mascot converts credibility into
contempt:

| Surface | Why |
| --- | --- |
| Destructive confirmations | Deleting a list is not a moment for a character |
| Billing failures, declined payments | The user is already annoyed and possibly embarrassed |
| Security alerts, session revocation, breach notices | Gravity is the entire message |
| Deliverability failures, blocklist hits, complaint spikes | Someone's sending reputation is on fire |
| Compliance, consent, and legal surfaces | Regulators and auditors read these |
| Data-loss or conflict resolution | The user needs to think, not be charmed |
| Any error attributable to the user | Never appear to be amused by someone's mistake |

Enforcement: a lint rule that fails the build if a moose component is imported
into a file under these route trees. A written guideline decays in a quarter; a
failing build does not. This is the same reasoning as the marketing site's
claims tests.

---

## 5. Timing, thresholds, and fatigue

Motion that appears too eagerly makes software feel *slower*, because it draws
attention to a wait the user had not noticed.

### Loader thresholds

| Operation duration | Behaviour |
| --- | --- |
| < 120ms | Show nothing. A flash of loader is worse than no loader. |
| 120ms – 400ms | Optimistic UI or skeleton. No moose. |
| > 400ms | Moose loader appears |
| Once shown | Remain visible ≥ 500ms even if the work finishes sooner |

That last row is the one usually missed: a loader that appears and vanishes in
80ms reads as a glitch. Once committed, hold it.

### Celebration budget

- At most **one** milestone animation per session.
- Never twice for the same event, across devices — the acknowledgement is a
  property of the account, not the client.
- First occurrence only. The second campaign sent is not an achievement.

Delight decays with repetition faster than anyone expects. Budget it like a
scarce resource, because it is one.

---

## 6. Accessibility

Not a compliance checkbox — several of these states are genuinely hazardous or
useless if done carelessly.

### Reduced motion

`prefers-reduced-motion: reduce` (and the RN `isReduceMotionEnabled` equivalent)
must be honoured everywhere, with a defined static fallback per state — not
simply "animation off," which would leave a determinate loader showing nothing.

| State | Reduced-motion fallback |
| --- | --- |
| Indeterminate | Static antlers at 60% + a text label |
| Determinate | Antlers snap to each new value, no tween |
| Shake | **No rotation at all.** Snow disappears instantly |
| Snow accumulation | Steps in 4 discrete levels rather than continuously |
| Empty state | Static illustration |

The shake is the important one. Rotational oscillation is a recognised
vestibular trigger; for a user with a vestibular disorder this is not a
preference, it is nausea. There is no "subtle version" exception.

### Screen readers

The moose is decorative and is `aria-hidden`. **The state it conveys must exist
independently as text** in an `aria-live="polite"` region:

```
Loading                → "Loading campaigns"
Determinate            → "Importing subscribers, 40 percent complete"   (throttled to ~10s)
Complete               → "Import complete"
Stale                  → "Data last updated 8 minutes ago"
```

WCAG 1.4.1 and 1.3.3 both apply: state must never be conveyed by a sensory
characteristic alone. Practically, this also means the animation can be deleted
entirely and the product still works — a good test of whether we built a system
or a decoration.

### Contrast

Snow is near-white on the paper ground, which is a genuine contrast problem. It
needs a defined edge (a 1px `mw-line` stroke) so it does not vanish on
`mw-paper`, and it must be tested in high-contrast mode.

---

## 7. Architecture: one geometry, four renderers

### The hard constraint nobody should discover the hard way

`sites/moosewave` is a **separate git repository** with an isolation test that
fails the build on any import escaping its own tree. It therefore **cannot
import a shared moose package.** It must vendor a copy, with a sync script and a
drift test comparing checksums. Any design that assumes a shared import breaks
the marketing site's isolation guarantee — which exists for good reasons and
should not be relaxed for a logo.

### Package layout

```
packages/moose/                    # geometry + state machine, zero rendering
  geometry.ts                      # path data, precomputed lengths
  states.ts                        # state machine: states, transitions, durations
  snow.ts                          # snowLevel(ageMs) — pure function, unit tested
  index.ts

packages/moose-react/              # SVG renderer — web + desktop
packages/moose-native/             # react-native-svg + Reanimated renderer
sites/moosewave/src/components/brand/   # VENDORED copy + drift test
```

### Geometry: precompute the path length

The draw animation needs `strokeDasharray` / `strokeDashoffset`, which requires
knowing the path's total length. `SVGPathElement.getTotalLength()` needs a DOM —
**React Native has no such API**, so measuring at runtime is impossible on
mobile and wasteful on web.

Precompute at build time and ship the number as a constant:

```ts
// packages/moose/geometry.ts
export const ANTLER_FILL_PATH = "M27,28 C23,25 …";   // the solid mitten, for the static mark
export const ANTLER_STROKE_PATH = "M28,26 C25,20 …"; // a CENTRELINE through the beam and palm
export const ANTLER_STROKE_LENGTH = 78.42;            // generated; asserted by test
```

Note these are **two different paths**. The static mark is a filled outline; you
cannot draw-on a fill. The loader needs a centreline traced through the beam and
around the palm — the route a growing antler would take. Deriving it
automatically from the fill is not worth the complexity; author it once, and let
a visual-regression test guard it.

### Motion tokens

`packages/design-tokens/src/motion.ts` already exports easing **dual-shaped** —
a `cubic-bezier(...)` string for CSS and a bezier tuple for JS. That is exactly
what a cross-platform motion system needs, and it should be extended rather than
duplicated:

```ts
moose: {
  drawMs: 900,          // one sweep, 0 → 100
  pingPongMs: 1800,     // full out-and-back cycle
  completeHoldMs: 400,
  shakeMs: 620,
  minVisibleMs: 500,    // anti-flash floor
  appearAfterMs: 400,   // threshold before showing at all
}
```

---

## 8. The performance constraint that dictates the implementation

**The loader must animate off the main thread, because the main thread being
busy is precisely why it is loading.**

This sounds obvious and is routinely violated. A JS-driven animation library
computes each frame on the same thread that is currently parsing a 4MB JSON
response — so the spinner stutters at exactly the moment smoothness matters
most, and stuttering motion reads as *the app has hung*.

| Platform | Use | Do **not** use |
| --- | --- | --- |
| Web / desktop | CSS `@keyframes` or WAAPI — composited, runs during main-thread work | `motion`/framer for loaders — JS-driven per frame |
| Mobile | Reanimated **worklets** — run on the UI thread | `Animated` on the JS thread |

We already depend on `motion` v11 on web and it stays right for scroll reveals
and layout transitions, where the main thread is idle. It is the wrong tool for
loaders specifically. This distinction should be a comment in the component, or
someone will "simplify" it back.

For determinate progress, drive `strokeDashoffset` via a CSS custom property so
updates cost a style recalculation rather than a React render:

```css
.moose-antler { stroke-dashoffset: calc(var(--antler-len) * (1 - var(--progress))); }
```

### Do not reach for Lottie or Rive in Tier 1

Both are excellent and both are wrong here. The geometry is already ours and
trivially small; Lottie would add a runtime, a JSON payload, and a second source
of truth for a shape we already maintain in code. Revisit only for Tier 3
full-body animation, and only if it demonstrably earns its bundle cost.

---

## 9. Per-platform application

### Marketing site (`sites/moosewave`)

Deliberately minimal. This site's job is to be fast and crawlable; animation is
mostly a liability. **Only** the waitlist submit uses the moose loader. The
header mark stays static. No snow, ever — there is no data to be stale.

### Web app (`apps/web`)

Replaces the existing spinner and complements the skeletons in
`components/dashboard/skeletons.tsx` — skeletons stay for layout-shaped waits;
the moose is for *operations*.

Determinate wins wherever we genuinely have progress, and several of the
product's best surfaces do:

- **Migration dry-run** — long, staged, genuinely measurable. The strongest case
  in the product for determinate antlers.
- **Campaign send** — progress across recipients.
- **Seedlist placement test** — progress across the panel.
- **Subscriber import** — rows processed.

Staleness snow belongs on the dashboard and analytics surfaces, next to the
existing "last updated" text rather than replacing it.

### Desktop (`apps/desktop`)

The motion laggard per the 2026-07 audit, so this is the largest relative
upgrade. Tauri also unlocks something the web cannot do:

- **Tray / dock icon as progress.** Render the antlers filling into the tray
  icon during a long send. The user switches away, and the brand mark itself
  reports progress in the system UI. This is the single most distinctive
  application of the whole system, and it exists only because the mark is
  simple enough to read at 22px.
- Window-level: a completed background job shakes the tray moose once.

### Mobile (`apps/mobile`)

The best home for the idea, because gesture makes it *interactive* rather than
merely observed.

**Pull-to-refresh is the flagship interaction:**

1. User pulls — antlers **draw in proportion to finger travel**. The user is
   drawing the antlers themselves. Progress is literal, not represented.
2. At threshold — antlers complete + **light impact haptic**.
3. Release — ping-pong while the request is in flight.
4. Response — **shake**, snow flies off, **success notification haptic**,
   snowLevel resets to zero.

That sequence turns a mechanical gesture into the brand's clearest single
expression, and every step of it carries information: how far you have pulled,
whether you have passed the threshold, that work is happening, that it finished.

`expo-haptics` is already a dependency and, per the product-love audit, largely
unwired — this is the natural occasion to wire it. Haptics must follow the same
reduced-motion gate: pair them with the visual state, never as a substitute.

Reanimated 4 + `react-native-svg` support animated `strokeDashoffset` in a
worklet, so the identical geometry and timing work here with no compromise.

---

## 10. Rollout

**Tier 1 — the loader.** `packages/moose` + `moose-react` + `moose-native`,
indeterminate and determinate, all four platforms, reduced-motion fallbacks,
aria-live text, the "forbidden surfaces" lint rule. This tier alone justifies
the project: it replaces generic spinners with something that carries more
information and is unmistakably ours.

**Tier 2 — staleness and refresh.** Snow model, shake, mobile pull-to-refresh
with haptics, desktop tray progress. Ship after Tier 1 has been in real use long
enough to know whether the loader is loved or tolerated.

**Tier 3 — character.** Empty states, milestones, seasonal variants. Only if
Tiers 1 and 2 earn it, and every item still has to pass §0.

---

## 11. How we will know it worked

Vibes are not evidence, and a mascot is exactly the kind of change teams
convince themselves succeeded.

| Question | Measure |
| --- | --- |
| Does the loader reduce abandonment? | Drop-off on operations > 3s, before vs after |
| Is it fatiguing? | Time-to-dismiss on milestones over successive occurrences — rising means annoyance |
| Is it accessible? | CI test asserting every state has a reduced-motion fallback and an aria-live string |
| Is it fast? | Frame timing during a main-thread-blocking operation — the loader must hold 60fps while the app is busy |
| Does snow get read? | Do users hover the timestamp less once snow ships? |

The frame-timing test is the one to automate first: it is the only measure that
catches the failure mode where the loader is beautiful in isolation and janky in
the exact conditions it exists for.

---

## 12. Open questions

1. **Does the determinate loader need a numeric readout beside it?** Antlers
   give shape, not precision. For a 40-minute migration, users likely want a
   figure. Leaning yes for long operations, no for short ones — needs testing.
2. **Tray-icon progress on Windows and Linux.** The macOS behaviour is clear;
   the others differ enough that this may be macOS-only in Tier 2.
3. **Is snow legible in dark mode?** White-on-dark inverts the contrast problem
   and may need a different treatment (frost on the edges rather than a cap).
4. **Do we want a moose at all in the ops console?** It is internal, high-stakes,
   and deliberately off-brand today. Probably not — but it should be a decision,
   not an oversight.

---

## Appendix: reference implementation sketch

```tsx
// packages/moose-react/src/MooseLoader.tsx
import { ANTLER_STROKE_PATH, ANTLER_STROKE_LENGTH } from "@moosewave/moose";

interface MooseLoaderProps {
  /** 0–1 for determinate; omit for indeterminate. */
  progress?: number;
  /** Announced to assistive tech. Required — the animation is never the message. */
  label: string;
}

export function MooseLoader({ progress, label }: MooseLoaderProps): JSX.Element {
  const determinate = progress !== undefined;

  return (
    <>
      <svg
        viewBox="0 0 64 64"
        aria-hidden="true"
        className={determinate ? "moose-determinate" : "moose-pingpong"}
        style={{
          // Custom properties, so determinate updates cost a style recalc
          // rather than a React render — and the animation itself is CSS, so
          // it keeps running while the main thread is busy.
          ["--antler-len" as string]: ANTLER_STROKE_LENGTH,
          ["--progress" as string]: determinate ? progress : undefined,
        }}
      >
        <path d={ANTLER_STROKE_PATH} className="moose-antler" />
        <g transform="translate(64,0) scale(-1,1)">
          <path d={ANTLER_STROKE_PATH} className="moose-antler" />
        </g>
        {/* head + muzzle render statically beneath */}
      </svg>

      {/* The state, as text. Delete the SVG above and this still works. */}
      <span role="status" aria-live="polite" className="sr-only">
        {determinate ? `${label}, ${Math.round(progress * 100)} percent complete` : label}
      </span>
    </>
  );
}
```

```css
.moose-antler {
  fill: none;
  stroke: currentColor;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-dasharray: var(--antler-len);
}

.moose-determinate .moose-antler {
  stroke-dashoffset: calc(var(--antler-len) * (1 - var(--progress)));
  transition: stroke-dashoffset 300ms var(--ease-standard);
}

.moose-pingpong .moose-antler {
  animation: moose-draw 1800ms var(--ease-standard) infinite alternate;
}

@keyframes moose-draw {
  from { stroke-dashoffset: var(--antler-len); }
  to   { stroke-dashoffset: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .moose-pingpong .moose-antler {
    animation: none;
    stroke-dashoffset: calc(var(--antler-len) * 0.4); /* static 60% */
  }
  .moose-determinate .moose-antler { transition: none; }
}
```
