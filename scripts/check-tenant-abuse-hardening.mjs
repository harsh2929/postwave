#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const checks = [
  {
    id: "dev_tenant_header_default_closed",
    file: "apps/api/.env.example",
    required: "POSTWAVE_DEV_TENANT_SLUG_HEADER=0",
  },
  {
    id: "dev_admin_header_default_closed",
    file: "apps/api/.env.example",
    required: "POSTWAVE_DEV_ADMIN_ROLE_HEADER=0",
  },
  {
    id: "forwarded_ip_trust_default_closed",
    file: "apps/api/.env.example",
    required: "POSTWAVE_TRUST_FORWARDED_IP_HEADERS=0",
  },
  {
    id: "readiness_blocks_dev_tenant_header",
    file: "apps/api/internal/readiness/readiness.go",
    required: "no_dev_tenant_header",
  },
  {
    id: "readiness_blocks_dev_admin_header",
    file: "apps/api/internal/readiness/readiness.go",
    required: "no_dev_admin_header",
  },
  {
    id: "api_key_rate_limiter_mounted",
    file: "apps/api/main.go",
    required: "middleware.NewKeyRateLimit",
  },
  {
    id: "public_ip_rate_limiter_mounted",
    file: "apps/api/main.go",
    required: "middleware.NewRateLimitWithOptions",
  },
  {
    id: "tenant_cleanup_internal_boundary",
    file: "packages/openapi/route-contracts.json",
    required: "internal-trust-boundary",
  },
  {
    id: "stream_helper_classified",
    file: "packages/openapi/route-contracts.json",
    required: "browser-stream-helper",
  },
];

let failed = false;
for (const check of checks) {
  const text = readFileSync(join(ROOT, check.file), "utf8");
  const ok = text.includes(check.required);
  console.log(`${ok ? "PASS" : "FAIL"} ${check.id}: ${check.file}`);
  if (!ok) {
    console.log(`  - missing ${check.required}`);
    failed = true;
  }
}

if (failed) process.exit(1);

console.log("\nTenant isolation and abuse-hardening checks passed.");
