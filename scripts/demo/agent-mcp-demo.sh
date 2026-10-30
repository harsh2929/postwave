#!/usr/bin/env bash
# Native MCP distribution and runtime demonstration are release-held. Keep this
# script fail-closed before environment reads, credential handling, or network.
set -euo pipefail

readonly HOLD_CODE="mcp_distribution_release_held"

printf '%s\n' "$HOLD_CODE" >&2
printf '%s\n' \
  "Native MCP is a non-runnable source candidate; no demo, working-key setup, or real-data execution is supported." >&2
exit 78
