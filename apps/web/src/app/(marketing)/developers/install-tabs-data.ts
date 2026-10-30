// SPDX-License-Identifier: AGPL-3.0-only

import type { InstallTab } from "@/components/marketing/install-tabs";

// Moosewave package namespaces are not published yet. Keep each ecosystem
// visible without directing users to legacy package names.
export const DEVELOPER_INSTALL_TABS = [
  {
    id: "npm",
    label: "npm",
    language: "bash",
    snippet: "Moosewave JavaScript SDK — Coming soon",
  },
  {
    id: "pnpm",
    label: "pnpm",
    language: "bash",
    snippet: "Moosewave JavaScript SDK — Coming soon",
  },
  {
    id: "track",
    label: "Browser events",
    language: "bash",
    snippet: "Moosewave browser events SDK — Coming soon",
  },
  {
    id: "pip",
    label: "pip",
    language: "bash",
    snippet: "Moosewave Python SDK — Coming soon",
  },
  {
    id: "composer",
    label: "Composer",
    language: "bash",
    snippet: "Moosewave PHP SDK — Coming soon",
  },
  {
    id: "cli",
    label: "CLI",
    language: "bash",
    snippet: "Moosewave CLI — Coming soon",
  },
] satisfies readonly InstallTab[];
