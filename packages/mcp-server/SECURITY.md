# Security policy

## Release status

`mcp_distribution_release_held` is authoritative. The mutable repository is an
unsupported private source-evaluation candidate, not a supported MCP
distribution, transport, hosted service, or client configuration. A manual
source build can execute with a supplied API key; that does not establish a
production/public release or governed-write guarantee. The historical `0.1.0`
artifact does not match the current source catalogue and is not
production-qualified.

## Supported versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | Release held       |

## Reporting a vulnerability

Please email `security@moosewave.com` rather than opening a public issue. Encrypt with our PGP key (fingerprint published at `https://moosewave.com/.well-known/security.txt`) if the report contains exploit details.

We aim to acknowledge within 2 business days and provide a fix or mitigation timeline within 7 business days.

## Scope

In scope for source-code vulnerability reports:
- The mutable `@postwave/mcp-server` source candidate.
- The transport implementation as code under review, not as a supported launch.
- The inert release-hold example records.

Out of scope:
- Any assumption that a hosted MCP endpoint or production transport exists.
- The hosted Moosewave API itself (report to the same address; tracked separately).
- Vulnerabilities in `@modelcontextprotocol/sdk` (please report upstream at `github.com/modelcontextprotocol/typescript-sdk`).

## Bounty

We don't currently run a paid bounty program. We do credit reporters in release notes by name + handle if you want.
