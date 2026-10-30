#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

const action = process.argv[2] ?? "build or start";

console.error(
  [
    `Refusing to ${action} @postwave/docs as a production application.`,
    "docs-site is an archived, non-production migration reference.",
    "Canonical public docs ship from apps/web/src/app/(docs)/docs.",
    "Use build:archive-preview or start:archive-preview only for local/CI archive review.",
  ].join("\n"),
);
process.exit(1);
