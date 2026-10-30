# Mobile assets

This directory contains the raster assets Expo packages for App Store and
Google Play builds. The checked-in `*-source.svg` files are the reproducible
masters; regenerate the PNGs with the commands below instead of editing the
rasters by hand. Keep `icon.png` fully opaque because App Store icons cannot
carry an alpha channel.

| File                    | Use                                    | Size                                                                    |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `icon.png`              | App icon (iOS + Android base)          | 1024×1024 opaque RGB PNG                                                |
| `adaptive-icon.png`     | Android adaptive foreground            | 1024×1024 RGBA PNG; artwork remains inside the centre 660×660 safe zone |
| `splash.png`            | Launch screen image                    | 1284×2778 opaque RGB PNG                                                |
| `notification-icon.png` | Android notification tray glyph        | 96×96 white-on-transparent RGBA PNG; Android applies the configured tint |

The artwork uses the canonical design tokens: warm ink `#0F0F0F`, ember
`#C8102E`, warm paper `#FDFCF8`, and celebratory gold `#F1C04C`. The Android
notification tint is the dark-theme ember `#E55262`. Keep these values aligned
with `@postwave/design-tokens` and `app.json`.

Regenerate on macOS/Linux with librsvg and ImageMagick:

```sh
rsvg-convert -w 1024 -h 1024 icon-source.svg -o icon.png
magick icon.png -alpha off -type TrueColor icon.png
rsvg-convert -w 1024 -h 1024 adaptive-icon-source.svg -o adaptive-icon.png
rsvg-convert -w 1284 -h 2778 splash-source.svg -o splash.png
magick splash.png -alpha off -type TrueColor splash.png
rsvg-convert -w 96 -h 96 notification-icon-source.svg -o notification-icon.png
```

After regeneration, run `pnpm --filter @postwave/mobile build` so the export
budget and native asset checks inspect the exact packaged files.
