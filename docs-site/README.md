# ARCHIVED — NON-PRODUCTION Nextra documentation

This Nextra tree is retained as a migration/reference archive. It is not a
deployable Moosewave workload, is not the source of current customer-facing
truth, and must not own `docs.moosewave.com` or any other public host.

The canonical production documentation is the route tree at
`apps/web/src/app/(docs)/docs`, built into the signed `@postwave/web` image and
governed by `docs-site/content-policy.json`. New or corrected customer-facing
content belongs there. Do not add a second current version here.

## Fail-closed controls

- This package's ordinary `build` and `start` scripts exit non-zero with an
  archive warning, and the root production build excludes this workspace.
- `next.config.mjs` refuses a production build unless
  `POSTWAVE_ARCHIVED_DOCS_PREVIEW=1` is explicitly set.
- The explicit `build:archive-preview` and `start:archive-preview` scripts are
  for local/CI migration review only.
- Every preview emits `X-Robots-Tag: noindex, nofollow, noarchive` and renders
  an archive warning in the shared theme.
- `scripts/check-documentation-contracts.mjs` rejects a return to active status,
  a production build script, missing archive markers, or known unsupported
  public claims.

These controls do not make the archived pages authoritative. They reduce the
risk of accidentally publishing old pricing, compliance, support, licensing,
region, availability, or release assertions while useful content is migrated.

## Review the archive locally

```bash
pnpm install
pnpm --filter @postwave/docs dev
```

For a production-mode compilation check that remains visibly non-production:

```bash
pnpm --filter @postwave/docs build:archive-preview
pnpm --filter @postwave/docs start:archive-preview
```

Do not connect this directory to Vercel, a public DNS name, or a deployment
pipeline. Retire it after any unique, evidence-backed material has been ported
to the canonical web docs.
