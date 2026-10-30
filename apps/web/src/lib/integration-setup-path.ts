// SPDX-License-Identifier: AGPL-3.0-only
//
// Maps a catalog item's backend `setup_path` (a logical surface key like
// "/integrations" or "/webhooks", assigned in apps/api/internal/integrations/
// catalog.go) to a REAL in-app dashboard route + a human label, so a
// browse-only detail page can offer a "Set up in {surface}" handoff instead of
// a dead-end (INTG-006). Unknown keys fall back to the integrations index,
// which hosts most connectors — every returned href is a route that exists.

import type { Route } from "next";

import { asRoute } from "./typed-routes";

interface SetupSurface {
  href: Route;
  label: string;
}

const SETUP_SURFACES: Record<string, SetupSurface> = {
  "/integrations": {
    href: asRoute("/app/integrations"),
    label: "Integrations",
  },
  "/commerce": { href: asRoute("/app/integrations"), label: "Integrations" },
  "/webhooks": {
    href: asRoute("/app/inbound-webhooks"),
    label: "Inbound webhooks",
  },
  "/audience-syncs": {
    href: asRoute("/app/integrations"),
    label: "Integrations",
  },
  "/data-platform": {
    href: asRoute("/app/integrations"),
    label: "Integrations",
  },
  "/api-playground": { href: asRoute("/docs/api"), label: "API reference" },
  "/mcp": { href: asRoute("/app/integrations"), label: "Integrations" },
  "/settings": { href: asRoute("/app/settings"), label: "Settings" },
  "/sending": { href: asRoute("/app/settings"), label: "Settings" },
  "/migrations": { href: asRoute("/app/migrations"), label: "Migrations" },
  "/sms-inbox": { href: asRoute("/app/sms"), label: "SMS" },
};

const FALLBACK: SetupSurface = {
  href: asRoute("/app/integrations"),
  label: "Integrations",
};

/** Resolves a backend setup_path to a real route + label, or null when empty. */
export function resolveSetupPath(
  setupPath?: string | null,
): SetupSurface | null {
  const key = (setupPath ?? "").trim();
  if (!key) return null;
  return SETUP_SURFACES[key] ?? FALLBACK;
}
