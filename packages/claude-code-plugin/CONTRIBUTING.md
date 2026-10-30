# Contributing

Thanks for your interest in improving `@postwave/claude-code-plugin`.

## Ground rules

- **MIT.** All contributions are accepted under the MIT license. By
  opening a PR, you certify your right to contribute under those terms.
- **No closed-source IP.** This package lives in the open-source layer
  of Moosewave. Do not add prompts, eval cases, or content that belongs
  to closed-source services. See `LICENSE-BOUNDARY.md` in the monorepo.
- **No realistic PII or vendor names.** Skill examples use neutral,
  abstract placeholders only.

## Local development

```bash
pnpm install
pnpm --filter @postwave/claude-code-plugin build
pnpm --filter @postwave/claude-code-plugin test
```

The installer path is release-held under
`mcp_distribution_release_held`. Do not run it against a project or publish
setup instructions. Tests may inspect its fail-closed status path without
installing skills or requesting credentials.

## Adding a skill

1. Create `skills/<slug>/SKILL.md` as a non-runnable design record with the
   release-hold code.
2. Keep the description explicit that the record must never be invoked.
3. Do not include tool calls, credential instructions, or mutation steps.
4. Add the slug to the `SKILL_DIRS` array in `src/cli.ts`.
5. Update `claude-md/POSTWAVE.md` and the README skill table.

## Pull requests

- One logical change per PR.
- Include a short description of the user-visible effect.
- CI must pass: lint + test + build.

## Code of conduct

This project follows the Contributor Covenant 2.1. See
`CODE_OF_CONDUCT.md`. Reports go to `conduct@postwave.dev`.

## Security

See `SECURITY.md` for how to report vulnerabilities.
