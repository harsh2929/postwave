// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

export { StrictCSPLayout as default } from "@/components/auth/strict-csp-layout";

export const metadata: Metadata = {
  title: "Accept invitation",
  robots: { index: false, follow: false, nocache: true },
};
