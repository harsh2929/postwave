#!/usr/bin/env bash
# check-flow-node-drift.sh
#
# The flow-builder catalog (apps/api) and the flow executor
# (services/automation) are two different services with no shared type. Nothing
# stopped the catalog from advertising a node the engine cannot run.
#
# It did exactly that: `exit` was catalogued RuntimeStatus:"supported", the
# builder's Validate() reported Executable:true for graphs containing it, and
# the engine's runNode switch had no case for it — so every journey that reached
# an exit node hit `unknown node type "exit"`, retried 5 times and deadlettered.
# The project's own flowbuilder test builds a graph terminating in an exit node.
#
# This gate makes that class of bug impossible: every node the catalog claims is
# "supported" must have a case in the engine's switch.
#
# Run from the repo root. Exits non-zero on drift.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CATALOG="apps/api/internal/flowbuilder/flowbuilder.go"
ENGINE="services/automation/internal/runtime/engine.go"

for f in "$CATALOG" "$ENGINE"; do
  if [[ ! -f "$f" ]]; then
    echo >&2 "check-flow-node-drift: missing $f"
    exit 1
  fi
done

# Node kinds the engine handles structurally rather than in runNode's switch.
# `trigger` entries are not executable nodes at all; the entry/terminal plumbing
# lives in Execute, not runNode.
EXEMPT=(
  "trigger"
)

violations=0

# Catalog entries look like:
#   {Key: "exit", Label: "Exit", Category: "control", RuntimeStatus: "supported"},
# Pull every Key whose RuntimeStatus is "supported" and whose Category is NOT a
# trigger.
while IFS= read -r line; do
  # A catalog line looks like:
  #   {Key: "send_email", Label: "…", Category: "action", RuntimeStatus: "supported",
  #    Fields: []FieldSpec{{Key: "template_id", …}, {Key: "subject", …}}},
  #
  # Note there are MULTIPLE {Key: "…"} on the line — the node's own key first,
  # then one per FieldSpec. Anchor to the FIRST (the node), or the guard ends up
  # demanding an executor case for field names like "template_id" and "url".
  key="$(sed -E 's/^[^{]*\{Key: "([a-z_]+)".*/\1/' <<<"$line")"
  category="$(sed -E 's/.*Category: "([a-z_]+)".*/\1/' <<<"$line")"

  # skip triggers — they are produced, not executed
  if [[ "$category" == "trigger" || "$category" == "triggers" ]]; then
    continue
  fi
  skip=0
  for e in "${EXEMPT[@]}"; do
    [[ "$key" == "$e" ]] && skip=1
  done
  (( skip )) && continue

  if ! grep -qE "case \"${key}\"" "$ENGINE"; then
    echo >&2 "DRIFT: flowbuilder advertises node \"${key}\" as RuntimeStatus:\"supported\", but ${ENGINE} has no \`case \"${key}\"\` — every journey reaching it will deadletter."
    violations=$((violations + 1))
  fi
done < <(grep -E '\{Key: "[a-z_]+".*RuntimeStatus: "supported"' "$CATALOG" || true)

if (( violations > 0 )); then
  cat >&2 <<'EOF'

Flow node drift detected.

A node advertised as "supported" that the engine cannot execute is worse than an
absent feature: the builder validates the graph, the operator ships it, and every
subscriber who reaches that node silently deadletters.

Either add the case to services/automation/internal/runtime/engine.go (runNode),
or downgrade the catalog entry's RuntimeStatus so the product stops claiming it.
EOF
  exit 1
fi

echo "flow node drift OK: every \"supported\" catalog node has an executor case"
