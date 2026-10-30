#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const lock = JSON.parse(await read("infra/aws/observability-image-lock.json"));
const expectedSourceFiles = [
  "builder-config.yaml",
  "collector/components.go",
  "collector/go.mod",
  "collector/go.sum",
  "collector/main.go",
  "collector/main_others.go",
  "collector/main_windows.go",
  "healthcheck/go.mod",
  "healthcheck/main.go",
];
const [manifest, dockerfile, goMod, componentsSource, mainSource] = await Promise.all([
  read(lock.builderManifest),
  read(path.join(lock.buildContext, "Dockerfile")),
  read(path.join(lock.generatedSource, "go.mod")),
  read(path.join(lock.generatedSource, "components.go")),
  read(path.join(lock.generatedSource, "main.go")),
]);

const expectedComponents = Object.values(lock.components).flat().sort();
const securityReplacements = [
  "golang.org/x/crypto => golang.org/x/crypto v0.56.0",
  "golang.org/x/image => golang.org/x/image v0.45.0",
  "golang.org/x/mod => golang.org/x/mod v0.40.0",
  "golang.org/x/text => golang.org/x/text v0.41.0",
  "google.golang.org/grpc => google.golang.org/grpc v1.83.2",
];
if (expectedComponents.length !== 7 || new Set(expectedComponents).size !== 7) {
  failures.push("the image lock must contain exactly seven unique collector components");
}

const manifestComponents = [...manifest.matchAll(/^\s*-\s+gomod:\s+(\S+)\s+(\S+)\s*$/gmu)]
  .map(([, module, version]) => `${module}@${version}`)
  .sort();
if (JSON.stringify(manifestComponents) !== JSON.stringify(expectedComponents)) {
  failures.push("builder-config.yaml does not exactly match the seven locked components");
}

for (const replacement of securityReplacements) {
  if (!manifest.includes(`  - ${replacement}`)) {
    failures.push(`builder manifest is missing security replacement ${replacement}`);
  }
  if (!goMod.includes(`replace ${replacement}`)) {
    failures.push(`generated go.mod is missing security replacement ${replacement}`);
  }
}

for (const component of expectedComponents) {
  const separator = component.lastIndexOf("@");
  const module = component.slice(0, separator);
  const version = component.slice(separator + 1);
  const generatedReference = `${module} ${version}`;
  if (!goMod.includes(`\n\t${module} ${version}`)) {
    failures.push(`generated go.mod is missing locked module ${component}`);
  }
  if (!componentsSource.includes(generatedReference) && !mainSource.includes(generatedReference)) {
    failures.push(`generated factory registration is missing ${component}`);
  }
}

const lockedSourceFiles = Object.keys(lock.sourceChecksums ?? {}).sort();
if (JSON.stringify(lockedSourceFiles) !== JSON.stringify(expectedSourceFiles)) {
  failures.push("the image lock must cover exactly the nine reviewed build-source files");
} else {
  for (const [relativePath, expectedDigest] of Object.entries(lock.sourceChecksums)) {
    const contents = await read(path.join(lock.buildContext, relativePath));
    const actualDigest = createHash("sha256").update(contents).digest("hex");
    if (actualDigest !== expectedDigest) {
      failures.push(`${relativePath} checksum is ${actualDigest}; expected ${expectedDigest}`);
    }
  }
}

for (const [condition, message] of [
  [lock.buildContext === "infra/observability/image", "build context must remain governed"],
  [lock.generatedSource === "infra/observability/image/collector", "generated source path must remain governed"],
  [
    lock.collectorBuilderModule ===
      `go.opentelemetry.io/collector/cmd/builder@${lock.upstreamRelease}`,
    "regeneration tool must match the locked upstream release",
  ],
  [lock.runtimeBase === "scratch" && dockerfile.includes("FROM scratch"), "runtime must remain scratch"],
  [dockerfile.includes(`ARG GO_IMAGE=${lock.builderImage}`), "builder image must match the lock"],
  [dockerfile.includes(`GOPROXY=${lock.moduleProxy}`), "module proxy must match the lock"],
  [dockerfile.includes("GOSUMDB=sum.golang.org"), "public checksum verification must remain enabled"],
  [dockerfile.includes("GOVCS=*:off"), "release builds must not fall back to mutable VCS fetches"],
  [dockerfile.includes("-mod=readonly"), "the checked-in module graph must be read-only"],
  [dockerfile.includes("go mod verify"), "downloaded modules must be verified before compilation"],
  [dockerfile.includes("COPY collector/ ./collector/"), "the release must compile checked-in generated source"],
  [!dockerfile.includes("go install "), "the release build must not regenerate the collector"],
]) {
  if (!condition) failures.push(message);
}

if (failures.length > 0) {
  process.stderr.write(`Collector source contract failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Collector source contract OK: ${expectedComponents.length} locked components and ${Object.keys(lock.sourceChecksums).length} verified source files.\n`,
  );
}
