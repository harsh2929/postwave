# @postwave/route-map

The **single source of truth** for how a Moosewave entity maps to a screen on every surface, and for the shared `moosewave://` deep-link + `https://app.moosewave.com` universal-link schemes.

## Why this exists

The 2026-06-21 ecosystem audit ([docs/ecosystem/](../../docs/ecosystem/)) found deep links were **auth-return plumbing, not entity handoff**:

- the desktop Tauri parser routed `approval|subscriber|campaign`,
- **mobile silently dropped** the entity scheme,
- **web — the declared link anchor — emitted no deep links at all**,
- and the universal links (AASA) covered only auth paths.

Deriving every surface's routing + link building from this one registry turns that latent plumbing into real continuity: open-on-one-continue-on-another, a web "copy link / open in app" affordance, and a desktop/mobile parser that agree by construction.

## Usage

```ts
import {
  buildDeepLink, buildUniversalLink, webPath, mobilePath,
  parseDeepLink, parseUniversalLink, ENTITIES,
} from "@postwave/route-map";

buildDeepLink("campaign", "cam_1");      // "moosewave://campaign/cam_1"
buildUniversalLink("campaign", "cam_1"); // "https://app.moosewave.com/app/campaigns/cam_1"
webPath("subscriber", "sub_42");         // "/app/subscribers/sub_42"  (web + desktop)
mobilePath("subscriber", "sub_42");      // "/(tabs)/subscribers/sub_42"

parseDeepLink("moosewave://campaign/cam_1?from=email"); // { entity: "campaign", id: "cam_1" }
parseUniversalLink("https://app.moosewave.com/app/campaigns/cam_1"); // { entity: "campaign", id: "cam_1" }
```

`isSafeResourceId` mirrors the desktop parser's allowlist so ids can't smuggle a second path segment, scheme, or traversal. Unknown actions/slugs and unsafe ids return `null` everywhere.

## Adoption

- **web** — a `CopyLinkButton` / "open in app" affordance built on `buildUniversalLink`.
- **mobile** — the Expo deep-link handler routes `parseDeepLink(url)` through `mobilePath`.
- **desktop** — the Rust `deep_link.rs` grammar should track `ENTITIES` (and gain the `migration` action so the migration-credential hand-off resolves).
