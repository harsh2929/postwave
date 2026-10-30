# Moosewave design language

The product UI and public site use the visual language established at
`https://design.moosewave.com/`. The implementation lives in shared tokens and
primitives so a new route inherits it without copying page-level CSS.

## Core palette

| Role        | Token       | Value     | Use                                  |
| ----------- | ----------- | --------- | ------------------------------------ |
| Paper       | `mw-paper`  | `#FFFbee` | Page canvas and light sheets         |
| Ink         | `mw-ink`    | `#20201E` | Text, outlines and dark chapters     |
| Cobalt      | `mw-blue`   | `#244CAD` | Links, focus and active navigation   |
| Highlighter | `mw-yellow` | `#FFDF38` | Primary tactile actions and emphasis |
| Pink        | `mw-pink`   | `#F2A8CC` | Chapter fields and expressive panels |
| Brand red   | `mw-red`    | `#D20A3A` | Moose mark and small signal accents  |

Semantic application tokens remain the source of truth for status, error,
success, warning and data visualization. Brand color never replaces meaning.

## Typography

- `font-sans`: the self-hosted Moosewave sans face for UI and body copy.
- `font-display`: the condensed display face for short, uppercase headlines.
- `font-hand`: the handwritten accent face for annotations, labels and short
  transitions. It is not body copy.
- `font-mono`: operational identifiers, request IDs, timestamps and code.

Large display lines should be short enough to scan. Dense product screens keep
the sans face for clarity.

## Shape and depth

- Product controls use modest asymmetric radii.
- Expressive marketing panels use `mw-cut-paper` with layout-specific rotation
  or proportion where a second silhouette is needed.
- Primary actions may use a hard 2–4 px ink shadow and a small press movement.
- Dense tables and operational cards use lighter depth so repeated surfaces do
  not turn into a wall of stickers.
- Paper grids are section accents, not a default texture on every component.

## Interaction

Cobalt is the focus color. Every control retains a visible keyboard ring and a
44 px coarse-pointer target. Hover movement stays within 1–3 px and is removed
under `prefers-reduced-motion`. Important state changes cannot depend on color,
rotation or animation alone.

## Implementation map

- Global tokens, fonts and composition utilities: `apps/web/src/app/globals.css`
- Tailwind aliases: `apps/web/tailwind.config.ts`
- Brand mark and wordmark: `apps/web/src/components/brand/moosewave-mark.tsx`
- Shared controls: `apps/web/src/components/ui/`
- Public shell: `apps/web/src/app/(marketing)/layout.tsx`
- Product shell: `apps/web/src/app/(dashboard)/dashboard-shell.tsx`
- Authentication shell: `apps/web/src/components/auth/auth-shell.tsx`

Do not introduce a one-off color, radius, logo or font when one of these roles
already expresses the intended meaning.
