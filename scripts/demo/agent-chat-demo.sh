#!/usr/bin/env bash
# The LLM-facing shared-registry demo is release-held with MCP distribution.
# Fail before environment reads, provider/key handling, or network activity.
set -euo pipefail

readonly HOLD_CODE="mcp_distribution_release_held"

printf '%s\n' "$HOLD_CODE" >&2
printf '%s\n' \
  "The in-app agent demo is a non-runnable source candidate; no working-key, provider, session, stream, or real-write demonstration is supported." >&2
exit 78
