// SPDX-License-Identifier: MIT
// Builds and probes the exact tarball that would be handed to a private
// evaluator. This is an evidence generator, NOT a publish or release command.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.private !== true) {
  throw new Error("Refusing to inspect a candidate whose release hold was removed");
}

const temp = mkdtempSync(join(tmpdir(), "moosewave-mcp-candidate-"));
try {
  execFileSync("pnpm", ["build"], { cwd: packageRoot, stdio: "inherit" });
  const source = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
  const sourceNames = source.candidateToolNames("templates");
  if (!sourceNames.length || sourceNames.some((name) => !name.startsWith("campaign_template_"))) {
    throw new Error("The template profile is empty or includes non-template tools");
  }
  if (new Set(sourceNames).size !== sourceNames.length) {
    throw new Error("The template profile contains duplicate tool names");
  }

  execFileSync("pnpm", ["pack", "--pack-destination", temp], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  const tarballs = readdirSync(temp).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error("Expected exactly one packed tarball");
  const tarball = join(temp, tarballs[0]);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  execFileSync("tar", ["-xzf", tarball, "-C", temp], { stdio: "inherit" });
  const installedRoot = join(temp, "package");
  const installedManifest = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  );
  if (
    installedManifest.version !== manifest.version ||
    installedManifest.private !== true ||
    installedManifest.bin?.["postwave-mcp"] !== "./dist/index.js"
  ) {
    throw new Error("Packed manifest differs from the release-held source manifest");
  }
  // Resolve dependencies exactly as this workspace does, but load the entry
  // from the extracted tarball, not from the working-tree dist directory.
  symlinkSync(join(packageRoot, "node_modules"), join(installedRoot, "node_modules"), "dir");
  const installed = await import(pathToFileURL(join(installedRoot, "dist/index.js")).href);
  const installedNames = installed.candidateToolNames("templates");
  if (JSON.stringify(installedNames) !== JSON.stringify(sourceNames)) {
    throw new Error("The installed template catalogue differs from the built source");
  }
  const catalogueDigest = createHash("sha256")
    .update(JSON.stringify(installedNames))
    .digest("hex");
  process.stdout.write(
    `${JSON.stringify({
      status: "candidate_verified_release_held",
      version: manifest.version,
      package_sha256: digest,
      template_tool_count: installedNames.length,
      template_catalogue_sha256: catalogueDigest,
      remaining_gates: [
        "new_immutable_version_and_registry_artifact_parity",
        "hosted_oauth_and_tenant_isolation",
        "working_tenant_key_and_client_lifecycle_qualification",
      ],
    }, null, 2)}\n`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
