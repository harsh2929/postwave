// SPDX-License-Identifier: AGPL-3.0-only
export { StrictCSPLayout as default } from "@/components/auth/strict-csp-layout";

// Per-route browser-tab title (AUTH-018). Pages are "use client" and cannot
// export metadata, so the server layout owns it. Root template → "Sign in ·
// Moosewave".
export const metadata = {
  title: "Sign in",
  robots: { index: false, follow: false, nocache: true },
};
