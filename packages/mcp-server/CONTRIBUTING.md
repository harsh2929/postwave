# Contributing to @postwave/mcp-server

Thanks for considering a contribution. This package is MIT-licensed and developed in the open.

## Code of conduct

This project adheres to the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). By participating you agree to uphold it. Report unacceptable behavior to `conduct@moosewave.com`.

## Where to file what

- **Bug?** Open an issue using the bug template.
- **Feature?** Open an issue using the feature-request template first — if the change is large we'll want to align before code review.
- **Security issue?** Do not file a public issue. See [SECURITY.md](./SECURITY.md).

## Development workflow

```bash
# 1. Clone + install
git clone https://github.com/harsh2929/postwave.git
cd Moosewave
pnpm install

# 2. Build
pnpm --filter @postwave/mcp-server build

# 3. Test
pnpm --filter @postwave/mcp-server test

# Runtime launch and real-tenant credential setup are release-held.
# Contributor verification stops at the isolated test suite above.
```

## PR process

1. Fork. Branch from `main`.
2. Make your change. Keep PRs small — one logical change per PR.
3. Add tests. We require coverage for any new tool, resource, or prompt.
4. Run `pnpm typecheck && pnpm test`. Both must pass.
5. Open the PR using the template. Reference the issue if there is one.
6. A maintainer will review within 7 days. Substantive merges happen on `main`; releases are tagged from `main`.

## Code style

- TypeScript strict mode, no `any`. Use Zod for runtime validation.
- License header on every TS source file: `// SPDX-License-Identifier: MIT`.
- Prefer named exports over default exports.
- Keep tool descriptions LLM-friendly: action-oriented, mentions inputs and outputs explicitly.
- No raw `fetch` — go through `@postwave/sdk`.
- No imports from `apps/` or `services/` — open-core boundary (see `LICENSE-BOUNDARY.md` in the parent repo).

## No secrets in commits

Never commit API keys, tokens, or anything resembling production credentials. The CI license-header check also greps for `pw_live_` / `sk_live_` / `Bearer .{20,}` patterns; commits matching are blocked.

## Adding a new tool

1. Decide which `tools/<category>.ts` file it belongs in.
2. Add a Zod input schema and a description string. Keep the description concrete and action-oriented (you are writing for an LLM router).
3. Wire the handler to the appropriate `@postwave/sdk` method. Do not introduce a new HTTP path that's not already in the OpenAPI spec.
4. Add a unit test in `tests/tools/<category>.test.ts` mocking the SDK.
5. Document the tool in `README.md` and add a one-liner to `apps/web/src/lib/mcp-tools.json` (if you're working in the parent monorepo) so the marketing page stays in sync.

## Releases

`@postwave/mcp-server` is release-held and excluded from both tag-driven and
manual publication by the protected `publish-packages.yml` plan. The manifest
is also `private: true`, so no current tag or dispatch is a publication path.
A future release requires an explicit review that removes both independent
holds and establishes a new immutable version, digest, and installed-artifact
contract; ordinary source contributions do not do that.

## License

By contributing, you agree your contributions are licensed under the MIT license, the same as the project.
