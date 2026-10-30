# Local desktop demo

On macOS, the complete product walkthrough can be launched from a fresh clone
with one command:

```bash
./scripts/demo/run-desktop-demo.sh
```

The launcher installs JavaScript dependencies, starts a loopback-only and
read-only demo API, creates a short-lived process-only demo credential, and
builds and opens a fresh local macOS app bundle with the explicit demo-data
profile. It does not touch Keychain or require Docker, Postgres, Redis, Go
services, a hosted Moosewave credential, or customer data.

Prerequisites are macOS, Node.js 20+ with pnpm/Corepack, Rust/Cargo, Git, and
the Xcode command-line tools. If one is missing, the launcher stops with a
short instruction instead of leaving a partial app running. Keep its Terminal
window open during the walkthrough; quitting Moosewave stops the temporary API
process. The first build can take a few minutes; subsequent launches reuse the
local build cache.

# Agent demo source records

## Native MCP status

`mcp_distribution_release_held`

The checked-in native MCP demo script is deliberately non-runnable. The wider
MCP implementation can be built for unsupported private source evaluation, but
this demo does not establish protocol compatibility, a hosted endpoint, client
availability, complete governance, or safety against real tenant data.
`agent-mcp-demo.sh` exits with the stable hold code before reading environment
variables, handling a credential, or making a network request.

There is no supported MCP launch command, API-key/scopes recipe, write-enabled
path, or real-data demo while the hold is active. A future demonstration must
identify a qualified immutable distribution/runtime and must be separately
reviewed before this record becomes executable.

The in-app agent source fixture shares the LLM-facing registry boundary and is
also non-runnable under this hold. `agent-chat-demo.sh` exits before reading
provider/API credentials or calling session, stream, or chat endpoints. Its
presence does not demonstrate working tools, real writes, or governance parity.
