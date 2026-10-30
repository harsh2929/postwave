# License Boundary — `@postwave/email-react`

This package is **Layer 2 (MIT)** under the Moosewave open-core architecture
(see the repository-root `LICENSE-BOUNDARY.md` for the full picture).

## Layer

- License: **MIT** (see `LICENSE`)
- Distribution: **npm** (`@postwave/email-react`)
- Source: `github.com/harsh2929/postwave/tree/main/packages/email-react`

## Hard rules

- Every source file MUST carry an `// SPDX-License-Identifier: MIT` header.
- This package MUST NOT import from `apps/`, `services/`, or `engine/`.
- This package MUST NOT contain Diagnostician prompts, voice generation
  prompts, deliverability eval cases, or any other closed-source IP.
- Allowed dependencies: other `packages/*` (MIT) and third-party MIT/BSD/
  Apache-2.0 packages from npm.
- The CLI entry (`postwave-email-render`) MUST NOT contact any internal
  Moosewave service — it operates entirely on local files.

## Why MIT here

The JSX → MJML primitives are dev-tool ergonomics. They have no proprietary
novelty, and being open removes the largest single piece of friction for
agentic workflows that produce email (Claude Code, Cursor, etc.).
Conversion to the paid Moosewave service still hinges on the closed-source
deliverability + voice IP, none of which lives here.
