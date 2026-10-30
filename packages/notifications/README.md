# @postwave/notifications

The **single source of truth** for Moosewave notification categories — one manifest mapping every server event to its category, copy, deep-link target, default-enabled flag, and per-channel eligibility.

## Why this exists

The 2026-06-21 ecosystem audit ([docs/ecosystem/](../../docs/ecosystem/)) found notification **copy + routing were duplicated mobile-only-by-convention**:

- the server's title/body switch lived in a retired public mobile relay rather
  than a current-user delivery channel,
- mobile re-derived the route in `apps/mobile/src/lib/deepLinks.ts`,
- desktop emitted only local OS notifications with no shared copy,
- the web PWA had **no push handler at all**.

> "A cohesive ecosystem defines notification categories + copy once (server-side) and every client renders them identically." — audit synthesis

This package is the TypeScript client contract. The dedicated Go mobile-device
sender mirrors the bounded event/default/copy set, and a cross-language test
rejects event or default-policy drift. Each client maps the same event and
deep-link entity consistently.

## Usage

```ts
import { notificationForEvent, defaultEnabledEvents } from "@postwave/notifications";

notificationForEvent("approval.requested");
// { title: "Approval needed", body: "A pending request is waiting…",
//   category: "approvals", defaultEnabled: true, deepLinkEntity: "approval", … }

notificationForEvent("campaign.sent", {
  entityId: "cam_1",
  fields: { campaignName: "Summer Sale" },
});
// { title: "Campaign sent", body: "Summer Sale finished sending.",
//   deepLink: "moosewave://campaign/cam_1",
//   universalLink: "https://app.moosewave.com/app/campaigns/cam_1", … }

defaultEnabledEvents(); // events ON by default for a new user
```

## Model

Each `NotificationDef` carries `{ event, category, titleTemplate, bodyTemplate, deepLinkEntity, defaultEnabled, channels }`. The **deep-link target reuses [`@postwave/route-map`](../route-map) entity keys** (`approval`, `campaign`, `subscriber`, `sequence`) — `notificationForEvent` builds the `moosewave://` and `https://app.moosewave.com` links via route-map's `buildDeepLink` / `buildUniversalLink`, so a notification reconstructs the **same entity on any surface** and this package never re-implements routing.

`{placeholder}` slots in the templates are filled from `ctx.fields`; a missing field is dropped cleanly (no literal `{campaignName}`, no doubled whitespace).

## Runtime contract

- **server** — `apps/api/internal/mobilepush` accepts only the mirrored event
  allowlist, renders bounded server-owned copy, and sends only `event_type` plus
  an opaque `entity_id` in device data. Its default flags must match this
  manifest test.
- **mobile / desktop / web** — gate client behavior on
  `channelEligible(event, channel)` and route through the shared entity map.
- Adding or changing a push event requires updating this manifest and the Go
  mirror in the same reviewed change.
