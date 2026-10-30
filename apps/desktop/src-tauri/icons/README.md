# Moosewave Desktop Icons

This directory contains the icon set Tauri bundles into the macOS / Windows /
Linux artifacts. The PNGs / .icns / .ico files in here are generated from
`source.svg` and should be regenerated together whenever the brand mark
changes.

## Regenerating from source

The single source of truth is `source.svg`. To regenerate every required
icon size, install the Tauri CLI and run:

```bash
pnpm tauri icon ./src-tauri/icons/source.svg
```

That command produces every file Tauri's bundler expects:

| File                    | Used by                       |
| ----------------------- | ----------------------------- |
| `32x32.png`             | Linux + small-size fallback   |
| `128x128.png`           | Linux                         |
| `128x128@2x.png`        | macOS / Linux retina          |
| `icon.icns`             | macOS `.app` bundle           |
| `icon.ico`              | Windows `.exe` and installers |
| `Square30x30Logo.png`   | Windows Store (MSIX)          |
| `Square44x44Logo.png`   | Windows Store (MSIX)          |
| `Square71x71Logo.png`   | Windows Store (MSIX)          |
| `Square89x89Logo.png`   | Windows Store (MSIX)          |
| `Square107x107Logo.png` | Windows Store (MSIX)          |
| `Square142x142Logo.png` | Windows Store (MSIX)          |
| `Square150x150Logo.png` | Windows Store (MSIX)          |
| `Square284x284Logo.png` | Windows Store (MSIX)          |
| `Square310x310Logo.png` | Windows Store (MSIX)          |
| `StoreLogo.png`         | Windows Store (MSIX)          |

Every listed artifact is committed. CI verifies the reviewed, tracked hashes
and fails if a required bundle icon is missing or changed; a release build
never downloads or synthesizes artwork.

`manifest.json` records the source and required release-artifact hashes. Run
`pnpm check:icons` after regeneration, review the visual output, then update
the manifest hashes in the same change.
