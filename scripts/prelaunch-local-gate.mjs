#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  {
    name: "Route parity",
    cmd: "node",
    args: ["scripts/check-route-parity.mjs"],
  },
  {
    name: "Route authorization manifest",
    cmd: "node",
    args: ["scripts/generate-route-capabilities.mjs", "--check"],
  },
  {
    name: "OpenAPI JSON sync",
    cmd: "python3",
    fallbackCmd: "python",
    args: ["packages/openapi/scripts/yaml-to-json.py", "--check"],
  },
  {
    name: "Production readiness static audit",
    cmd: "node",
    args: ["scripts/audit-production-readiness.mjs"],
  },
  {
    name: "Security scan inventory coverage",
    cmd: "node",
    args: ["scripts/check-security-scan-coverage.mjs"],
  },
  {
    name: "Dependency audit policy fixtures",
    cmd: "pnpm",
    args: ["test:audit-js"],
  },
  {
    name: "Production JavaScript dependency audit",
    cmd: "pnpm",
    args: ["audit:js"],
  },
  {
    name: "Public claims register",
    cmd: "node",
    args: ["scripts/check-public-claims.mjs"],
  },
  {
    name: "Backup and disaster recovery contract",
    cmd: "bash",
    args: ["scripts/check-backup-dr.sh"],
  },
  {
    name: "Third-party license policy",
    cmd: "pnpm",
    args: ["licenses:check"],
  },
  {
    name: "Tenant isolation and abuse hardening",
    cmd: "node",
    args: ["scripts/check-tenant-abuse-hardening.mjs"],
  },
  {
    name: "Worker DB safety",
    cmd: "node",
    args: ["scripts/check-worker-db-safety.mjs"],
  },
  {
    name: "SDK parity",
    cmd: "node",
    args: ["scripts/check-sdk-parity.mjs"],
  },
  {
    name: "Provider rehearsal preflight",
    cmd: "node",
    args: ["scripts/providers/rehearsal-preflight.mjs"],
  },
  {
    name: "Launch decision register",
    cmd: "node",
    args: ["scripts/check-launch-decisions.mjs"],
  },
  {
    name: "Bounded request-body contract",
    cmd: "go",
    args: ["-C", "apps/api", "run", "./cmd/checkrequestbodies", "--root", "."],
  },
  {
    name: "Core Go test slice",
    cmd: "go",
    args: [
      "test",
      "./apps/api/internal/readiness",
      "./apps/api/internal/events",
      "./apps/api/internal/middleware",
      "./apps/api/internal/apikeys",
      "./services/automation/internal/handlers",
      "./services/automation/internal/runtime",
      "./services/automation/internal/canonical",
      "./services/deliverability/internal/...",
      "./services/migration/internal/orchestrator",
      "./packages/migrate/...",
    ],
  },
  {
    name: "Python SDK contract tests",
    cmd: "python3",
    fallbackCmd: "python",
    args: ["-m", "pytest", "packages/sdk-py/tests"],
  },
  {
    name: "Web typecheck",
    cmd: "pnpm",
    args: ["--filter", "@postwave/web", "typecheck"],
  },
  {
    name: "Archived docs preview build",
    cmd: "pnpm",
    args: ["--filter", "@postwave/docs", "build:archive-preview"],
  },
];

for (const step of steps) {
  console.log(`\n==> ${step.name}`);
  const result = run(step.cmd, step.args);
  if (result.status === 127 && step.fallbackCmd) {
    console.log(
      `Primary command '${step.cmd}' not found; retrying with '${step.fallbackCmd}'.`,
    );
    const fallback = run(step.fallbackCmd, step.args);
    if (fallback.status !== 0) process.exit(fallback.status ?? 1);
    continue;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nPrelaunch local gate passed.");

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "inherit",
    shell: false,
  });
}
