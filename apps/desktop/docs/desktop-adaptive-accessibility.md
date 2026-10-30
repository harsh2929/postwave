# Desktop adaptive accessibility contract

Date: 2026-07-16  
Audit item: DUX-037  
Source status: `IN PROGRESS`

This document records the source-level minimum-window, zoom/reflow, contrast,
motion and theme work. It does not turn renderer simulation into signed native
qualification. DUX-037 becomes `VERIFIED` only after the exact macOS and
Windows artifact matrix at the end of this document is attached to an immutable
build.

## Product contract

### Window geometry

- The native primary window defaults to 1100×720 CSS pixels, is resizable, and
  cannot be resized below 880×560.
- The Rust window-lifecycle test reads `tauri.conf.json` and pins all four
  values. The renderer source contract independently reads the same file.
- `.app-shell`, `.main`, `.content` and `.sidebar` have explicit zero minimum
  block sizes. Task content and navigation—not the document or shell—own
  overflow.
- At the compact-shell breakpoint the sidebar becomes a 64px icon rail. A late
  cascade rule guarantees the full-width announcement card cannot reappear in
  that rail.
- At the 200% layout proxy, secondary status metadata (API URL and build
  version) yields before connection and queued-work state. Nothing wraps the
  fixed status bar or forces the shell beyond the viewport. Both secondary
  values remain available in Settings/About.
- The lazy navigation fallback uses the canonical visually-hidden utility;
  loading copy is announced without being squeezed visibly into the icon rail.

### Theme preference versus resolved palette

The store now models two different facts:

| Fact | Values | Purpose |
| --- | --- | --- |
| `themePreference` | `system`, `light`, `dark` | Durable operator choice |
| `theme` | `light`, `dark` | Palette currently rendered by components |

System is not represented as “no preference.” Missing and invalid legacy
values migrate in memory to System. Selecting System persists the literal
`system` value. Explicit Light/Dark choices never change when the OS palette
changes.

When System is selected, a live `prefers-color-scheme: light` listener updates
the resolved palette without reload. A `storage` listener applies a choice made
in another app window. Removed or malformed sibling-window values fall back to
System. Storage or media-query denial degrades to an in-memory choice and the
historical Dark palette; it does not prevent boot.

The document root exposes `data-theme-preference` for truthful inspection while
preserving the existing CSS contract: Light sets `data-theme="light"`; Dark
uses the root token defaults. Settings exposes a labelled System/Light/Dark
radiogroup, identifies System as recommended, reports its current resolved
palette, and explains that updates apply across open windows. Account and
workspace quick toggles continue to choose an explicit opposite palette and
now disclose when the current palette came from System.

### Contrast and motion foundations

- The global forced-colors contract restores a two-pixel `Highlight` focus
  outline and uses system colors for common controls, borders and overlay
  surfaces.
- The global reduced-motion contract collapses animation and transition time,
  disables smooth scrolling, and has component-specific static replacements
  where a generic clamp would hide progress.
- Qualified primitives, data tables, charts, large-data rows, shortcuts and
  contextual Help add their own forced-colors/reduced-motion behavior rather
  than depending only on color tokens.
- These source rules are safeguards, not measured installed contrast evidence.
  The audit’s named token pairs and every stateful control still require
  resolved-pixel measurement in both signed platform engines.

## Behavior and failure matrix

| Scenario | Required result |
| --- | --- |
| No stored theme | System; immediately resolve the OS palette |
| Stored `system` | System; follow later OS changes live |
| Stored `light` or `dark` | Render exactly that palette; ignore OS changes |
| Invalid/missing cross-window value | Safely return to System |
| Storage read/write denied | Continue in memory; no crash or false success dependency |
| `matchMedia` unavailable/throws | System remains selected; Dark is safe resolved fallback |
| Sibling window changes preference | Apply once without reload or write-back loop |
| Native 880×560 | Shell/body stay bounded; compact rail and task scroll remain usable |
| 200% layout proxy (440×280) | Same scroll ownership; no shell/body clipping or wrap growth |
| Forced colors | Focus and structural boundaries remain perceivable with system colors |
| Reduced motion | Task state remains visible without sustained spatial motion |

## Automated evidence

Current focused checkpoint:

- 22/22 Vitest cases across theme behavior, account-menu integration and the
  DUX-037 source contract.
- Optimized Chromium: live System Dark → Light → Dark transition passes without
  reload.
- Optimized Chromium: actual 880×560 geometry and the deterministic 440×280
  200%-layout proxy both keep shell/body overflow within two pixels.
- App TypeScript, renderer-test TypeScript, scoped zero-warning ESLint and
  scoped Stylelint pass.

The layout proxy is deliberately named as a proxy. It proves CSS-pixel reflow
behavior; it does not prove Windows display scaling, WebView zoom, native text
scaling or assistive-technology behavior.

## Evidence still required before `VERIFIED`

Use the exact signed release candidates and record artifact digest, OS/WebView
version, hardware/display profile, operator, timestamp and outcome.

1. macOS Intel and Apple Silicon plus Windows x64 at the supported minimum and
   current OS/WebView versions.
2. Clean launch and live Light/Dark/System changes, including two open windows,
   relaunch, storage denial and corrupted prior state.
3. Every persistent destination and representative modal/slideover/popover at
   880×560, default size, 200% zoom/text scale and the supported 400% reflow or
   text-spacing check.
4. Windows 125/150/200% display scaling, macOS Retina/non-Retina and mixed-DPI
   display movement, maximize/full-screen and display disconnect/reconnect.
5. Windows High Contrast/forced colors, macOS Increase Contrast/Reduce
   Transparency, reduced motion and both themes with resolved-pixel contrast
   measurement for text, focus, borders, selection, disabled and status states.
6. Keyboard-only completion with focus never obscured by sticky chrome,
   overlays or notices; VoiceOver and Narrator reading/focus recordings for
   critical workflows.
7. Long/non-Latin content, increased text spacing, dynamic loading/error/offline
   states and overlay-open resize. No action, error, identity or recovery path
   may be clipped or available only by pointer.

Until that matrix and the destination-wide responsive sweep pass, DUX-037
remains `IN PROGRESS` even though the live System preference and shell-level
source behavior are implemented.
