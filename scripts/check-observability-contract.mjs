#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

await import("./check-observability-collector-source.mjs");

const root = process.cwd();
const contract = JSON.parse(
  await readFile(path.join(root, "config/observability-contract.json"), "utf8"),
);

const failures = [];
const metricNames = new Set(Object.keys(contract.metrics));
const queryBuiltinMetrics = new Set(["up"]);

for (const [metric, relativeFile] of Object.entries(contract.metrics)) {
  const source = await readFile(path.join(root, relativeFile), "utf8");
  const declared = metric.endsWith("_bucket")
    ? metric.slice(0, -"_bucket".length)
    : metric;
  const escaped = declared.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`Name:\\s*${JSON.stringify(declared)}`, "u").test(source)) {
    failures.push(
      `${metric}: emitter ${relativeFile} does not declare ${declared}`,
    );
  }
  if (!new RegExp(`\\b${escaped}\\b`, "u").test(source)) {
    failures.push(
      `${metric}: emitter ${relativeFile} does not contain the metric name`,
    );
  }
}

const expressionMetrics = new Set();
for (const relativeFile of contract.prometheusFiles) {
  const source = await readFile(path.join(root, relativeFile), "utf8");
  const expressions = relativeFile.endsWith(".json")
    ? collectJSONExpressions(JSON.parse(source))
    : [...source.matchAll(/^\s*expr:\s*(.+)$/gmu)].map((match) => match[1]);
  if (expressions.length === 0)
    failures.push(`${relativeFile}: no PromQL expressions found`);
  for (const expression of expressions) {
    for (const match of expression.matchAll(
      /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?=\{|\[)/gu,
    )) {
      const metric = match[1];
      expressionMetrics.add(metric);
      if (!metricNames.has(metric) && !queryBuiltinMetrics.has(metric)) {
        failures.push(
          `${relativeFile}: PromQL references ${metric}, which has no governed emitter`,
        );
      }
    }
  }
}

for (const metric of metricNames) {
  if (!expressionMetrics.has(metric))
    failures.push(
      `${metric}: governed emitter is absent from release dashboard/alerts`,
    );
}

const serviceEntrypoints = [
  "apps/api/main.go",
  "services/migration/main.go",
  "services/deliverability/main.go",
  "services/voice/main.go",
  "services/automation/main.go",
];
for (const relativeFile of serviceEntrypoints) {
  const source = await readFile(path.join(root, relativeFile), "utf8");
  if (!source.includes("runtimeobs.ProtectMetrics(")) {
    failures.push(
      `${relativeFile}: /metrics is not protected by the shared access policy`,
    );
  }
  for (const field of [
    "ReadHeaderTimeout:",
    "ReadTimeout:",
    "WriteTimeout:",
    "IdleTimeout:",
    "MaxHeaderBytes:",
  ]) {
    if (!source.includes(field))
      failures.push(`${relativeFile}: HTTP server is missing ${field}`);
  }
}

const tracing = await readFile(
  path.join(root, "packages/runtime/observability/tracing.go"),
  "utf8",
);
if (tracing.includes("WithInsecure("))
  failures.push(
    "shared tracing contains an unconditional insecure exporter option",
  );
for (const rawPathTelemetryPattern of [
  /span\.SetName\([^\n]*r\.URL\.Path/u,
  /SetAttributes\([^\n]*r\.URL\.Path/u,
  /attribute\.String\([^\n]*r\.URL\.Path/u,
  /semconv\.[A-Za-z]+\(r\.URL\.Path\)/u,
]) {
  if (rawPathTelemetryPattern.test(tracing)) {
    failures.push("shared tracing uses attacker-controlled raw paths");
    break;
  }
}
for (const requiredSensitiveIngressControl of [
  "IsPublicSupportIntegrationPath(r.URL.Path)",
  "RedactSensitivePath(originalURL.Path)",
  'telemetryURL.RawQuery = ""',
]) {
  if (!tracing.includes(requiredSensitiveIngressControl)) {
    failures.push(
      `shared tracing is missing sensitive-ingress control ${requiredSensitiveIngressControl}`,
    );
  }
}
for (const duplicate of [
  "apps/api/internal/observability/tracing.go",
  "services/migration/internal/observability/tracing.go",
  "services/deliverability/internal/observability/tracing.go",
]) {
  try {
    await readFile(path.join(root, duplicate), "utf8");
    failures.push(
      `${duplicate}: duplicated tracing implementation still exists`,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const compose = await readFile(
  path.join(root, "infra/docker-compose.full.yml"),
  "utf8",
);
if (!compose.includes('OTEL_EXPORTER_OTLP_INSECURE: "true"')) {
  failures.push(
    "local Jaeger plaintext export lacks an explicit local-only insecure opt-in",
  );
}

const alarmTemplate = await readFile(
  path.join(root, "infra/aws/cloudwatch-alarms.yaml"),
  "utf8",
);
if (alarmTemplate.includes("…") || alarmTemplate.includes("Add rest")) {
  failures.push(
    "CloudWatch alarm template still contains a deployment placeholder",
  );
}

const observabilityStack = await readFile(
  path.join(root, "infra/aws/observability-stack.yaml"),
  "utf8",
);
for (const { job, target } of contract.scrapeTargets) {
  if (
    !observabilityStack.includes(`job_name: ${job}`) ||
    !observabilityStack.includes(`targets: [${target}]`)
  ) {
    failures.push(
      `observability stack is missing governed scrape target ${job} -> ${target}`,
    );
  }
}
const credentialUses = [
  ...observabilityStack.matchAll(/credentials: \$\{!env:METRICS_TOKEN\}/gu),
].length;
if (credentialUses !== contract.scrapeTargets.length) {
  failures.push(
    `observability stack has ${credentialUses} authenticated scrapes; expected ${contract.scrapeTargets.length}`,
  );
}
const collectorParameter = observabilityStack.slice(
  observabilityStack.indexOf("  CollectorImageDigest:"),
  observabilityStack.indexOf("  DeployCollector:"),
);
if (collectorParameter.includes("Default:")) {
  failures.push(
    "collector digest must be supplied explicitly and cannot have a fallback default",
  );
}

const collectorLock = JSON.parse(
  await readFile(
    path.join(root, "infra/aws/observability-image-lock.json"),
    "utf8",
  ),
);
const collectorDockerfile = await readFile(
  path.join(root, "infra/observability/image/Dockerfile"),
  "utf8",
);
if (
  collectorLock.runtimeBase !== "scratch" ||
  !collectorDockerfile.includes("FROM scratch") ||
  !collectorDockerfile.includes(`ARG GO_IMAGE=${collectorLock.builderImage}`) ||
  !collectorDockerfile.includes("COPY collector/ ./collector/") ||
  !collectorDockerfile.includes("-mod=readonly") ||
  collectorDockerfile.includes("go install ")
) {
  failures.push(
    "minimal collector build does not match its reviewed toolchain lock",
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `Observability contract failed:\n- ${failures.join("\n- ")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Observability contract OK: ${metricNames.size} governed metrics, ${contract.scrapeTargets.length} protected targets, TLS tracing, bounded servers.\n`,
  );
}

function collectJSONExpressions(value) {
  if (Array.isArray(value)) return value.flatMap(collectJSONExpressions);
  if (!value || typeof value !== "object") return [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "expr" && typeof child === "string") out.push(child);
    else out.push(...collectJSONExpressions(child));
  }
  return out;
}
