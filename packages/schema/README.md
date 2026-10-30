# @postwave/schema

Shared canonical schema for Moosewave migration, voice, and automation pillars. Single source of truth for cross-service contract types.

MIT licensed (Layer 2 of [Moosewave's open-core architecture](https://github.com/harsh2929/postwave/blob/main/LICENSE-BOUNDARY.md)).

## Install

```sh
npm install @postwave/schema
# or
pnpm add @postwave/schema
```

## Use

```ts
import { Subscriber, Campaign, Sequence } from "@postwave/schema";

function shouldEnroll(s: Subscriber, seq: Sequence): boolean {
  return s.status === "subscribed" && seq.status === "active";
}
```

The same shapes are codegen'd into Go for the Moosewave gateway and services — that's why this package exists separately from `@postwave/sdk`. Use `@postwave/sdk` for HTTP calls; use `@postwave/schema` when you need just the types (e.g. building tools that read Moosewave data without making API calls).

## What's in here

| Module | Exports |
|---|---|
| `subscribers` | `Subscriber`, `SubscriberStatus`, `SubscriberCreateInput` |
| `campaigns` | `Campaign`, `CampaignStatus`, `CampaignReport` |
| `sequences` | `Sequence`, `SequenceStep`, `SequenceTrigger` |
| `voice` | `VoiceProfile`, `Tonal`, `Persona`, `Vocabulary` |
| `migration` | `MigrationJob`, `MigrationStatus`, `MigrationProgress` |
| `automation` | `Automation`, `AutomationNode`, `AutomationTrigger` |

## Versioning

Semver. Major bumps when type shapes change in breaking ways. Minor bumps when fields are added (additive — won't break existing consumers because TypeScript widens). Patch bumps for doc/comment-only changes.

## Related

- [`@postwave/sdk`](https://github.com/harsh2929/postwave/tree/main/packages/sdk-ts) — TypeScript SDK that uses these types
- [`@postwave/openapi`](https://github.com/harsh2929/postwave/tree/main/packages/openapi) — OpenAPI 3.1 spec for the same surface
- [`@postwave/mcp-server`](https://github.com/harsh2929/postwave/tree/main/packages/mcp-server) — release-held Model Context Protocol source candidate; unsupported private evaluation only

## License

MIT. © Moosewave.
