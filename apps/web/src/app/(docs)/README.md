# Canonical public documentation tree

The runtime routes under `docs/` in this route group are the sole canonical
customer-facing Moosewave documentation. They ship inside the signed
`@postwave/web` image governed by the AWS web release contract.

The standalone Nextra project under `docs-site/` is an archived,
non-production migration reference. Do not copy claims from it without
revalidating them against current code, the supported-feature matrix, live
provider evidence, approved commercial terms, and the current production
platform record.

Documentation changes here must:

- avoid duplicating prices, refunds, limits, compliance, region, certification,
  uptime, continuity, support, or provider claims without dated evidence and an
  accountable owner;
- distinguish implemented source from configured, certified, deployed, and
  commercially available behavior;
- use generated OpenAPI and MCP catalogs instead of handwritten endpoint/tool
  inventories where possible; and
- pass `pnpm docs:contracts` and the normal `@postwave/web` quality gates.

Canonical status and the archive fail-closed rules are machine-checked through
`docs-site/content-policy.json` and
`scripts/check-documentation-contracts.mjs`.
