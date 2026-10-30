#!/usr/bin/env node
// Drift gate for the canonical agent-tool registry. The in-code registry
// (apps/api/internal/agenttools, populated by the native MCP server) is the
// single source of truth; the checked-in native_manifest.json must always
// reflect it. Fails CI when they diverge — i.e. someone added/changed a
// tool without regenerating the manifest.
//
//   pnpm audit:tools
//
// To fix a reported drift:  (cd apps/api && go run ./cmd/genagenttools)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(root, "apps", "api");

const res = spawnSync("go", ["run", "./cmd/genagenttools", "-check"], {
  cwd: apiDir,
  stdio: "inherit",
});

if (res.error) {
  console.error("audit:tools: failed to run the Go generator:", res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 1);
