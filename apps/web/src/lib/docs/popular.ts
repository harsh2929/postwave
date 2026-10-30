// SPDX-License-Identifier: AGPL-3.0-only
//
// Curated "most-read" docs destinations — a single source of truth shared by
// the getting-started landing page ("Most-read articles") and the ⌘K search
// empty state (MKTN-020). Kept client-safe: the only dynamic value is a static
// count derived from a JSON import, so this module can be imported into the
// SearchBar client component without dragging server-only loaders into the
// browser bundle.
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_SOURCE_CANDIDATE_TOOL_COUNT,
} from "@/lib/mcp-release-status";

export interface PopularDoc {
  href: string;
  label: string;
}

export const POPULAR: readonly PopularDoc[] = [
  { href: "/docs/quickstart", label: "Quickstart" },
  {
    href: "/docs/migrations/activecampaign",
    label: "Migrate from ActiveCampaign",
  },
  { href: "/docs/migrations/mailchimp", label: "Migrate from Mailchimp" },
  {
    href: "/docs/skills",
    label: `MCP source catalog (${MCP_SOURCE_CANDIDATE_TOOL_COUNT} definitions; ${MCP_RELEASE_HOLD_CODE})`,
  },
  { href: "/docs/integrations/stripe", label: "Stripe integration" },
  {
    href: "/docs/integrations/custom-domains",
    label: "Set up a custom domain",
  },
  { href: "/docs/changelog", label: "Latest changelog" },
];
