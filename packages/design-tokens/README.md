# @postwave/design-tokens

The **single source of truth** for the Moosewave brand — ember on warm-paper, Inter + Fraunces — across every client (web, desktop, mobile, email).

## Why this exists

Before this package the brand was hand-duplicated in three places and synced by comment:

- `apps/web/src/app/globals.css` — HSL custom properties
- `apps/desktop/src/styles.css` — `--pw-*` hex variables
- `apps/mobile/src/lib/theme.ts` — a JS hex object

The 2026-06-21 ecosystem audit ([docs/ecosystem/](../../docs/ecosystem/)) confirmed they had **drifted**:

- Desktop's dark canvas was a **cool blue-slate** (`#0c0e14`) instead of the warm ink (`#0F0F0F`) web and mobile use.
- Status colors diverged: `success` `#10b981` (desktop) vs `#34d399` (mobile); `info` `#818cf8` vs `#7aa2f0`; `warning` `#eab308` vs `#f1c04c`.
- Even web's own declared HSL had drifted from its hex comments (`--background: 40 33% 98%` ≠ `#FDFCF8`, which is `48 56% 98%`).

This package makes the brand **parity-by-construction**: one canonical hex palette, consumed (or generated into) every client, with a CI drift guard so it can't silently re-diverge — mirroring how `@postwave/openapi` guards the wire contract.

## Canonical decisions

| Token             | Light                | Dark               | Note                                                                             |
| ----------------- | -------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `accent` (ember)  | `#C8102E`            | `#E55262`          | brand / CTA / active / selected — never positive-status                          |
| `bg`              | `#FDFCF8` warm paper | `#0F0F0F` warm ink | dark canvas is **ink, not blue-slate**                                           |
| `success`         | `#1E7A55`            | `#34D399`          | positive status is green, not ember                                              |
| `successEmphasis` | `#196748`            | `#34D399`          | AA-safe status ink on subtle and low-alpha green surfaces                        |
| `gold`            | `#F2B233`            | `#F1C04C`          | the single celebratory spark                                                     |
| `danger`          | `#D43C1F`            | `#F0623D`          | hue-distinct from ember                                                          |
| `dangerEmphasis`  | `#B1341B`            | `#F48367`          | AA-safe destructive fill and text on a 10% danger wash across canonical surfaces |

Light values follow `apps/web` (which carries the AA-contrast tuning). The dark canvas and status hues are unified to the web/mobile values; desktop's outliers are corrected.

## Usage

```ts
// Mobile / any JS consumer — the palette IS the RN theme shape:
import { light, dark, fonts, radius } from "@postwave/design-tokens";

// Web (Tailwind/shadcn) — generate `hsl(var(--x))` triplets:
import { toCssVars, WEB_VAR_MAP } from "@postwave/design-tokens";
const rootVars = toCssVars("light", WEB_VAR_MAP, "hsl-triplet");

// Desktop — generate `--pw-*` hex vars:
import { toCssVars, DESKTOP_VAR_MAP } from "@postwave/design-tokens";
const darkVars = toCssVars("dark", DESKTOP_VAR_MAP, "hex");
```

> **Drift correction on adoption.** Wiring web to this package shifts its declared HSL to the _true_ conversion of the brand hex (e.g. `--background` `40 33% 98%` → `48 56% 98%`). This is intentional — the hex is the brand's real intent; the old HSL was a lossy approximation. Sanity-check the light/dark canvas visually after adoption.

## Drift guard

`BRAND_ANCHORS` exports the hex values that must appear, byte-identical, in every client's theme (ember light/dark, paper, ink, warm border, gold). A CI check asserts each client still matches — see `scripts/check-design-token-drift.mjs` (added when consumers are wired).
