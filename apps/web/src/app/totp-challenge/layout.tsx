// SPDX-License-Identifier: AGPL-3.0-only
export { StrictCSPLayout as default } from "@/components/auth/strict-csp-layout";

// Per-route browser-tab title (AUTH-018) — set on the server layout since the
// page is a client component.
export const metadata = {
  title: "Two-factor authentication",
  robots: { index: false, follow: false, nocache: true },
};
