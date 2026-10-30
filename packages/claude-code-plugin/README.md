# `@postwave/claude-code-plugin`

## Release status

`mcp_distribution_release_held`

This publishable package is a source candidate for a future Claude Code
integration. It is not a released installer, MCP runtime, hosted service, or
working-key setup. The default CLI exits with the hold code before it prompts,
copies a skill, or changes a project.

The checked-in skill files and `CLAUDE.md` fragment are non-runnable design
inputs only. They do not establish current tool availability, tool counts, or
feature parity with the API. Do not install, invoke, or request credentials for
them.

Existing local copies may be removed with the CLI's explicit `--uninstall`
cleanup mode. No installation command is supported while this hold is active.

## Source inventory

- Seven non-runnable skill design records under `skills/`.
- One non-runnable conventions record under `claude-md/`.
- A fail-closed status CLI under `src/`.

The mutable repository can differ from any immutable package artifact. A future
release must publish a versioned artifact, verify its exact contents, and lift
this hold before setup instructions or availability claims are added.

MIT licensed. See `LICENSE`.
