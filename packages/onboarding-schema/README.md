# `@postwave/onboarding-schema`

Shared, dependency-free onboarding contracts for Moosewave web, desktop, and
mobile clients. The package contains the canonical checklist goals, adaptive
tour schema, onboarding-progress response types, empty-state copy, contextual
hints, and analytics property types.

## Install

```bash
npm install @postwave/onboarding-schema
```

## Example

```ts
import {
  CHECKLIST_GOALS,
  adaptiveSteps,
  isOnboardingProgress,
  type TourStep,
} from "@postwave/onboarding-schema";

const steps: TourStep[] = [
  {
    id: "verify-domain",
    title: "Verify your sending domain",
    body: "Add the DNS records, then run the verifier.",
    skipIfGoalDone: "verified_sending_identity",
  },
];

const visibleSteps = adaptiveSteps(steps, (key) => completedGoals.has(key));
```

`CHECKLIST_GOALS` stays aligned with `GET /api/v1/onboarding-progress`; tests
fail when the server and client step keys diverge. Each application remains
responsible for mapping abstract route, target, and illustration keys to its
native UI.

## Development

```bash
pnpm --filter @postwave/onboarding-schema typecheck
pnpm --filter @postwave/onboarding-schema test
```

MIT licensed. Source and issues are maintained in the
[Moosewave monorepo](https://github.com/harsh2929/postwave/tree/main/packages/onboarding-schema).
