# Contributing to @postwave/cli

Thanks for considering a contribution! This package is MIT-licensed and
developed in `github.com/harsh2929/postwave/tree/main/packages/cli`.

## Development

```sh
pnpm install
pnpm --filter @postwave/cli dev      # tsup --watch
pnpm --filter @postwave/cli test
pnpm --filter @postwave/cli typecheck
```

## PR checklist

- [ ] Source files start with `// SPDX-License-Identifier: MIT`.
- [ ] No `any`. Strict TS only.
- [ ] New commands carry zod input validation when they accept JSON.
- [ ] Tests cover at least the happy path of any new behavior.
- [ ] Updated the command reference in `README.md` when introducing a command.

## Reporting bugs

Open an issue in the Moosewave monorepo. Please include the CLI version
(`postwave --version`) and the relevant command line. Do **not** include
a real API key in the report.
