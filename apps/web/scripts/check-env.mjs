// SPDX-License-Identifier: AGPL-3.0-only

import { validateEnvExample, validateWebEnv } from "./env-schema.mjs";

const mode = process.argv[2] ?? "all";
const checks = [];

if (mode !== "--example-only") {
  checks.push(["process.env", validateWebEnv(process.env)]);
}
if (mode !== "--current-only") {
  checks.push([".env.example", validateEnvExample()]);
}

const failures = checks.flatMap(([label, result]) =>
  result.failures.map((failure) => `${label}: ${failure}`),
);

if (failures.length > 0) {
  console.error("[postwave/web env] invalid environment:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[postwave/web env] ok");
