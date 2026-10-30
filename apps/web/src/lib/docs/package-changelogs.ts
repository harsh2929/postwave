// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-package release notes for /docs/changelog, bundled at build time.
//
// The page used to read packages/*/CHANGELOG.md with fs when it rendered. The
// release image is Next's standalone output: only files the build's tracer can
// follow are copied into it, and a path assembled in a loop is not one it can
// follow (packages/mcp-server is also excluded from the image on purpose). So
// the image carried none of the files, every read failed into a silent
// `catch {}`, and production showed "No CHANGELOG.md files found." Importing
// the files makes their text part of the server bundle instead: what the build
// saw is what the page shows, wherever it runs.

import claudeCodePluginChangelog from "../../../../../packages/claude-code-plugin/CHANGELOG.md?raw";
import claudeCodePluginManifest from "../../../../../packages/claude-code-plugin/package.json";
import cliChangelog from "../../../../../packages/cli/CHANGELOG.md?raw";
import cliManifest from "../../../../../packages/cli/package.json";
import emailReactChangelog from "../../../../../packages/email-react/CHANGELOG.md?raw";
import emailReactManifest from "../../../../../packages/email-react/package.json";
import mcpServerChangelog from "../../../../../packages/mcp-server/CHANGELOG.md?raw";
import mcpServerManifest from "../../../../../packages/mcp-server/package.json";
import migrateChangelog from "../../../../../packages/migrate/CHANGELOG.md?raw";
import openapiChangelog from "../../../../../packages/openapi/CHANGELOG.md?raw";
import openapiManifest from "../../../../../packages/openapi/package.json";
import schemaChangelog from "../../../../../packages/schema/CHANGELOG.md?raw";
import schemaManifest from "../../../../../packages/schema/package.json";
import sdkTsChangelog from "../../../../../packages/sdk-ts/CHANGELOG.md?raw";
import sdkTsManifest from "../../../../../packages/sdk-ts/package.json";
import vscodeExtensionChangelog from "../../../../../packages/vscode-extension/CHANGELOG.md?raw";
import vscodeExtensionManifest from "../../../../../packages/vscode-extension/package.json";

export interface PackageChangelog {
  /** The directory under packages/. */
  directory: string;
  /**
   * The name the package is published under. Directory and published name
   * differ for two of them — packages/sdk-ts publishes as @postwave/sdk and
   * packages/vscode-extension as postwave-vscode — so it is read from each
   * package.json. packages/migrate is a Go module with no package.json; it
   * publishes under the brand name.
   */
  name: string;
  body: string;
}

/** Notes this large would bloat every server bundle that renders the page. */
export const MAX_CHANGELOG_BYTES = 512 * 1024;

const ENTRIES: ReadonlyArray<PackageChangelog> = [
  { directory: "openapi", name: openapiManifest.name, body: openapiChangelog },
  { directory: "mcp-server", name: mcpServerManifest.name, body: mcpServerChangelog },
  { directory: "sdk-ts", name: sdkTsManifest.name, body: sdkTsChangelog },
  { directory: "cli", name: cliManifest.name, body: cliChangelog },
  { directory: "schema", name: schemaManifest.name, body: schemaChangelog },
  { directory: "migrate", name: "@postwave/migrate", body: migrateChangelog },
  { directory: "email-react", name: emailReactManifest.name, body: emailReactChangelog },
  {
    directory: "claude-code-plugin",
    name: claudeCodePluginManifest.name,
    body: claudeCodePluginChangelog,
  },
  {
    directory: "vscode-extension",
    name: vscodeExtensionManifest.name,
    body: vscodeExtensionChangelog,
  },
];

/** Every package's release notes, in the order the page lists them. */
export function packageChangelogs(): PackageChangelog[] {
  return ENTRIES.filter(
    (entry) => new TextEncoder().encode(entry.body).byteLength <= MAX_CHANGELOG_BYTES,
  );
}
