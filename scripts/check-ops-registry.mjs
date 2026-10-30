#!/usr/bin/env node
// Every ops check must carry a Why and a Remediation, and IDs must be unique.
//
// A check whose consequence nobody can state is a check nobody will action.
// A red row you cannot act on is a nag, not a control.
//
//   pnpm audit:ops
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(root, "apps", "api");

const res = spawnSync("go", ["run", "./cmd/genopschecks", "-check"], {
  cwd: apiDir,
  stdio: "inherit",
});

if (res.error) {
  console.error("audit:ops: could not run the Go registry check:", res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 1);
